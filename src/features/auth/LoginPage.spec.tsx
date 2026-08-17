import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LoginPage } from './LoginPage';

// Controllable auth + navigation mocks so each test can drive a specific backend
// login outcome and assert what the screen does with it.
const login = vi.hoisted(() => vi.fn());
const selectCompany = vi.hoisted(() => vi.fn());
const changeExpiredPassword = vi.hoisted(() => vi.fn());
const requestPasswordReset = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@/api/auth', () => ({ requestPasswordReset }));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ login, selectCompany, changeExpiredPassword }),
}));
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));

const NEUTRAL = "If an account matches, we've sent a reset link to the email on file.";

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  login.mockReset();
  selectCompany.mockReset();
  changeExpiredPassword.mockReset();
  requestPasswordReset.mockReset();
  navigate.mockReset();
});

describe('LoginPage forgot-password flow', () => {
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
    requestPasswordReset.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByText('Forgot your password?'));
    await user.type(screen.getByPlaceholderText('Username or email'), 'does-not-exist@example.com');
    await user.click(screen.getByText('Send reset link'));

    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
  });

  it('starts the forgot-password field EMPTY even when a username was typed into login (shared-tablet leak)', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByPlaceholderText('Username'), 'driver.jones');
    await user.click(screen.getByText('Forgot your password?'));

    const resetField = screen.getByPlaceholderText('Username or email') as HTMLInputElement;
    expect(resetField.value).toBe('');
  });

  it('surfaces a retry message on network failure without revealing account state', async () => {
    requestPasswordReset.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByText('Forgot your password?'));
    await user.type(screen.getByPlaceholderText('Username or email'), 'driver.jones');
    await user.click(screen.getByText('Send reset link'));

    await waitFor(() => expect(screen.getByText(/Could not send the reset link/)).toBeInTheDocument());
    expect(screen.queryByText(NEUTRAL)).not.toBeInTheDocument();
  });
});

describe('LoginPage — all five backend login statuses (A1)', () => {
  async function signIn() {
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByPlaceholderText('Username'), 'driver.jones');
    await user.type(screen.getByPlaceholderText('Password'), 'whatever12!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    return user;
  }

  it('mfa_required → shows a clear "not supported on this device" message, does NOT crash or navigate', async () => {
    login.mockResolvedValue({ status: 'mfa_required', mfaToken: 't' });
    await signIn();

    expect(await screen.findByText(/isn't supported on this device/i)).toBeInTheDocument();
    expect(screen.getByText(/office app/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('mfa_setup_required → shows the same unsupported message', async () => {
    login.mockResolvedValue({ status: 'mfa_setup_required', setupToken: 't' });
    await signIn();

    expect(await screen.findByText(/isn't supported on this device/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('password_expired → opens an in-app set-new-password step instead of crashing', async () => {
    login.mockResolvedValue({ status: 'password_expired', changeToken: 'chg-1' });
    await signIn();

    expect(await screen.findByPlaceholderText('New password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Confirm new password')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('password_expired → resolves end-to-end in-app: sets the new password and finishes the login', async () => {
    login.mockResolvedValue({ status: 'password_expired', changeToken: 'chg-1' });
    changeExpiredPassword.mockResolvedValue({
      status: 'authenticated',
      accessToken: 'a',
      company: { id: 'c', name: 'Co' },
    });
    const user = await signIn();

    await user.type(await screen.findByPlaceholderText('New password'), 'Str0ng-Pass!');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'Str0ng-Pass!');
    await user.click(screen.getByRole('button', { name: /Set new password and continue/i }));

    await waitFor(() => expect(changeExpiredPassword).toHaveBeenCalledWith('chg-1', 'Str0ng-Pass!'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('password_expired → a weak new password is rejected client-side, before any server call', async () => {
    login.mockResolvedValue({ status: 'password_expired', changeToken: 'chg-1' });
    const user = await signIn();

    await user.type(await screen.findByPlaceholderText('New password'), 'weak'); // <8 chars, missing classes
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'weak');
    await user.click(screen.getByRole('button', { name: /Set new password and continue/i }));

    expect(screen.getByText(/too weak/i)).toBeInTheDocument();
    expect(changeExpiredPassword).not.toHaveBeenCalled();
  });

  it('choose_company still works (regression)', async () => {
    login.mockResolvedValue({
      status: 'choose_company',
      preAuthToken: 'pre-1',
      companies: [{ id: 'c1', name: 'Acme Freight' }],
    });
    const user = await signIn();

    await user.click(await screen.findByRole('button', { name: 'Acme Freight' }));
    expect(selectCompany).toHaveBeenCalledWith('pre-1', 'c1');
  });
});
