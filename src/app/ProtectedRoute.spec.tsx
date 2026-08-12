import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProtectedRoute } from './ProtectedRoute';

// Controllable auth + lock state, driven per-test.
const authState = vi.hoisted(() => ({
  status: 'authenticated' as 'loading' | 'authenticated' | 'unauthenticated',
  logout: vi.fn(),
}));
const lockState = vi.hoisted(() => ({ locked: false }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authState,
}));
vi.mock('@/hooks/useAppLock', () => ({
  useAppLock: () => lockState,
}));
// LockScreen pulls in the real lock lib; stub it to a marker so this test stays
// focused on the guard's branching, not the PIN UI.
vi.mock('@/features/lock/LockScreen', () => ({
  LockScreen: () => <div>Lock screen</div>,
}));

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/protected']}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/protected" element={<div>Protected content</div>} />
        </Route>
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    authState.status = 'authenticated';
    authState.logout = vi.fn();
    lockState.locked = false;
  });

  it('shows a loading state while auth is resolving', () => {
    authState.status = 'loading';
    renderGuard();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('redirects to /login when unauthenticated', () => {
    authState.status = 'unauthenticated';
    renderGuard();
    expect(screen.getByText('Login page')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('shows the lock screen when authenticated but locked', () => {
    authState.status = 'authenticated';
    lockState.locked = true;
    renderGuard();
    expect(screen.getByText('Lock screen')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders the guarded outlet when authenticated and unlocked', () => {
    authState.status = 'authenticated';
    lockState.locked = false;
    renderGuard();
    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Lock screen')).not.toBeInTheDocument();
  });
});
