import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { AuthProvider } from '@/app/providers/AuthProvider';
import { router } from '@/app/router';
import { initSyncEngine } from '@/lib/sync-engine';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A tablet with patchy connectivity retrying a failed query five times
      // in a row is worse than showing the cached/error state promptly.
      retry: 1,
      // Was 0 (everything stale on mount → refetch on every screen change), which
      // wastes the one thing a field tablet can't spare: a flaky mobile link.
      // 30s treats freshly-read data as fresh across navigation; screens that
      // need tighter freshness already set their own staleTime/refetchInterval.
      staleTime: 30_000,
      // Hold data long enough that flicking between Today/Messages/Glovebox
      // paints from cache instead of a "Loading…" every time.
      gcTime: 10 * 60_000,
      // Never auto-refetch just because the driver tabbed away and back — it
      // burns data and can wipe a good cached view for an offline error.
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  useEffect(() => {
    initSyncEngine();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
