import { Link } from 'react-router';

/** Branded catch-all for an unknown URL — DriverOS is used on phones, so keep it simple and thumb-friendly. */
export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold text-(--text-primary)">Page not found</h1>
      <p className="max-w-xs text-sm text-(--text-tertiary)">This page doesn't exist. Head back to your day.</p>
      <Link
        to="/"
        className="inline-flex min-h-14 items-center justify-center rounded-xl bg-accent-500 px-6 text-base font-medium text-white"
      >
        Back to Today
      </Link>
    </div>
  );
}
