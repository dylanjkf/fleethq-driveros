import { Navigate, Outlet } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { useAppLock } from '@/hooks/useAppLock';
import { LockScreen } from '@/features/lock/LockScreen';

export function ProtectedRoute() {
  const { status, logout } = useAuth();
  const { locked } = useAppLock();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center text-(--text-tertiary)">Loading…</div>
    );
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }
  // Authenticated but auto-locked (idle/background timeout): gate the UI behind
  // the PIN without tearing down the session or the offline outbox (M4).
  if (locked) {
    return <LockScreen onSignOut={logout} />;
  }
  return <Outlet />;
}
