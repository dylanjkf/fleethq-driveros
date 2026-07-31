import { Navigate, Outlet } from 'react-router';
import { useAuth } from '@/hooks/useAuth';

export function ProtectedRoute() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center text-(--text-tertiary)">Loading…</div>
    );
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
