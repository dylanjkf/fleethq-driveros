import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LoginPage } from './LoginPage';

// The forgot-password request view is the shared-tablet crux: it must fire the
// backend recovery call and then show ONE neutral confirmation that does not
// change based on whether an account matched. These tests drive it through the
// real component with the API + auth boundaries mocked.
const requestPasswordReset = vi.hoisted(() => vi.fn());
vi.mock('@/api/auth', () => ({ requestPasswordReset }));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ login: vi.fn(), selectCompany: vi.fn() }),
}));

const NEUTRAL = "If an account matches, we've sent a reset link to the email on file.";

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe('LoginPage forgot-password flow', () => {
  beforeEach(() => {
    requestPasswordReset.mockReset();
  });

  it('sends the identifier and shows the neutral confirmation on success', async () => {
    requestPasswordReset.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByText('Forgot your password?'));
    await user.type(screen.getByPlaceholderText('Username or email'), 'driver.jones');
    await user.click(screen.getByText('Send reset link'));

    expect(requestPasswordReset).toHaveBeenCalledWith('driver.jones');
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
  });

  it('shows the SAME neutral message regardless of the response (non-enumerating)', async () => {
    // A resolved call is all the component ever sees — the endpoint is silent —
    // so there is no branch that could reveal account existence. Prove the exact
    // confirmation text is what renders.
    requestPasswordReset.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByText('Forgot your password?'));
    await user.type(screen.getByPlaceholderText('Username or email'), 'does-not-exist@example.com');
    await user.click(screen.getByText('Send reset link'));

    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
    // No new-password field is ever collected on the shared tablet.
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
  });

  it('surfaces a retry message on network failure without revealing account state', async () => {
    requestPasswordReset.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByText('Forgot your password?'));
    await user.type(screen.getByPlaceholderText('Username or email'), 'driver.jones');
    await user.click(screen.getByText('Send reset link'));

    await waitFor(() =>
      expect(screen.getByText(/Could not send the reset link/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(NEUTRAL)).not.toBeInTheDocument();
  });
});
