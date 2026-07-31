import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { listNotifications, markAllNotificationsRead, markNotificationRead, type NotificationList } from '@/api/notifications';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusBar } from '@/components/ui/StatusBar';

const NOTIFICATIONS_KEY = ['notifications'];

/** DriverOS notifications: new job assignments and office messages, in-app. */
export function NotificationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: NOTIFICATIONS_KEY, queryFn: listNotifications, refetchInterval: 20_000 });

  // Optimistically clear the unread dot the instant it's tapped — the marking
  // itself is idempotent (and offline-safe in the api layer), so onSettled
  // reconciles against the server and onError rolls the cache back on failure.
  const readOne = useMutation({
    mutationFn: markNotificationRead,
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const previous = queryClient.getQueryData<NotificationList>(NOTIFICATIONS_KEY);
      queryClient.setQueryData<NotificationList>(NOTIFICATIONS_KEY, (old) => {
        if (!old) return old;
        const now = new Date().toISOString();
        const items = old.items.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: now } : n));
        return { ...old, items, unreadCount: items.filter((n) => !n.readAt).length };
      });
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(NOTIFICATIONS_KEY, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
  const readAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const previous = queryClient.getQueryData<NotificationList>(NOTIFICATIONS_KEY);
      queryClient.setQueryData<NotificationList>(NOTIFICATIONS_KEY, (old) => {
        if (!old) return old;
        const now = new Date().toISOString();
        const items = old.items.map((n) => (n.readAt ? n : { ...n, readAt: now }));
        return { ...old, items, unreadCount: 0 };
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(NOTIFICATIONS_KEY, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  const items = data?.items ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="flex items-center gap-3 px-6 py-4">
        <button className="text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>← Back</button>
        <h1 className="text-xl font-bold">Notifications</h1>
        {(data?.unreadCount ?? 0) > 0 && (
          <button className="ml-auto text-sm font-semibold text-accent-500" onClick={() => readAll.mutate()}>
            Mark all read
          </button>
        )}
      </div>

      <div className="flex-1 space-y-3 px-6 pb-8">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex gap-3 rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
              <Skeleton className="mt-1.5 h-2.5 w-2.5 flex-none rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))
        ) : items.length === 0 ? (
          // Distinguish a genuinely empty inbox from one we simply couldn't load:
          // saying "all caught up" while offline would be a lie.
          <p className="text-(--text-secondary)">
            {data?.fromCache ? "Offline — can't check for new alerts right now." : "You're all caught up."}
          </p>
        ) : (
          items.map((n) => (
            <button
              key={n.id}
              onClick={() => {
                if (!n.readAt) readOne.mutate(n.id);
                if (n.linkPath) navigate(n.linkPath);
              }}
              className={`flex w-full gap-3 rounded-2xl border border-(--border-subtle) p-4 text-left ${n.readAt ? 'bg-(--surface-1)' : 'bg-(--surface-2)'}`}
            >
              {!n.readAt && <span className="mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-accent-500" />}
              <span className={n.readAt ? 'pl-[22px]' : ''}>
                <span className="block font-semibold">{n.title}</span>
                {n.body && <span className="block text-sm text-(--text-secondary)">{n.body}</span>}
                <span className="block text-xs text-(--text-tertiary)">{new Date(n.createdAt).toLocaleString()}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
