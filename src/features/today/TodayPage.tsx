import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { getMyFatigueStatus } from '@/api/fatigue';
import { getTodayJobs } from '@/api/jobs';
import { listNotifications } from '@/api/notifications';
import { getSupportInfo } from '@/api/companies';
import { cacheOptimisticShift, endShift, getCurrentShift, startShift, type CurrentShiftResult, type Shift } from '@/api/shifts';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusBar } from '@/components/ui/StatusBar';
import { useAuth } from '@/hooks/useAuth';
import { enablePushNotifications, getPushSubscriptionState, isPushSupported } from '@/lib/push-registration';
import { directionsUrl } from '@/lib/maps';
import { useLocationReporter } from '@/hooks/useLocationReporter';
import type { JobStop } from '@/api/types';

const PUSH_DISMISSED_KEY = 'driveros:push-banner-dismissed';

function stopUrl(jobId: string, stop: JobStop): string {
  const params = new URLSearchParams({ jobId, stopId: stop.id, label: stop.label });
  if (stop.address) params.set('address', stop.address);
  if (stop.windowEnd) params.set('windowEnd', stop.windowEnd);
  return `/stop?${params.toString()}`;
}

/**
 * DriverOS's home screen (04-DriverOS/DriverOS_Overview.md): "today's job/
 * route, replacing the old 'what's next' phone call or SMS." Scoped to
 * showing the operator's currently-assigned Job(s) — no live map/route yet
 * (05-Dispatch/Dispatch_Overview.md's own unbuilt scope).
 */
export function TodayPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const operatorId = user?.operator?.id;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['today-jobs', operatorId],
    queryFn: () => getTodayJobs(operatorId!),
    enabled: !!operatorId,
    // Cached-fallback data is already "fresh enough" by design — refetching
    // constantly would just thrash the network for no benefit.
    staleTime: 60_000,
  });

  const { data: notifs } = useQuery({ queryKey: ['notifications'], queryFn: listNotifications, refetchInterval: 20_000 });
  const unread = notifs?.unreadCount ?? 0;

  // Warm the support-phone cache during the normal online session, so the Help
  // screen's tel: link still works for a driver who first opens Help offline.
  useQuery({ queryKey: ['support-info'], queryFn: getSupportInfo, staleTime: 60 * 60_000 });

  const [shiftSyncNote, setShiftSyncNote] = useState<string | null>(null);

  const shiftQuery = useQuery({
    queryKey: ['shift', 'current'],
    queryFn: getCurrentShift,
    enabled: !!operatorId,
    retry: false,
  });

  // 08-Compliance/Australian_Compliance.md's fatigue tracking: the operator
  // sees their own risk, not just the office. No offline fallback — see
  // api/fatigue.ts's own reasoning — so this silently doesn't render when
  // the request fails rather than showing a stale, possibly-wrong status.
  const fatigueQuery = useQuery({
    queryKey: ['fatigue', 'me'],
    queryFn: getMyFatigueStatus,
    enabled: !!operatorId,
    retry: false,
    refetchInterval: 5 * 60_000,
  });
  const fatigue = fatigueQuery.data;
  const fatigueFlags = fatigue ? [...fatigue.breaches, ...fatigue.approaching] : [];

  // While on shift, the tablet reports its position so the office can see it on
  // the dispatch board. Best-effort and non-blocking (see the hook) — it does
  // nothing if geolocation is denied/unavailable or the context isn't secure.
  const onShift = shiftQuery.data?.shift?.status === 'ACTIVE';
  useLocationReporter(!!onShift);

  async function onShiftActionSettled(result: { queued: boolean }, action: 'start' | 'end') {
    if (result.queued) {
      // Offline: the refetch would fall back to the *old* cached state and the
      // widget would still show the wrong button — so reflect the intended state
      // now, in both the live query and the offline cache. This is what stops a
      // driver double-tapping "Start shift" in a dead zone and queuing a second
      // start the server later rejects.
      const current = shiftQuery.data?.shift ?? null;
      const optimistic: Shift | null =
        action === 'start'
          ? { id: current?.id ?? 'pending-shift', status: 'ACTIVE', startedAt: new Date().toISOString(), endedAt: null }
          : current
            ? { ...current, status: 'ENDED', endedAt: new Date().toISOString() }
            : null;
      queryClient.setQueryData<CurrentShiftResult>(['shift', 'current'], { shift: optimistic, fromCache: true });
      await cacheOptimisticShift(optimistic);
      setShiftSyncNote("Saved — it'll sync when you're back online.");
      setTimeout(() => setShiftSyncNote(null), 4000);
    } else {
      queryClient.invalidateQueries({ queryKey: ['shift', 'current'] });
      setShiftSyncNote(null);
    }
  }

  const startShiftMutation = useMutation({
    mutationFn: startShift,
    onSuccess: (result) => onShiftActionSettled(result, 'start'),
  });
  const endShiftMutation = useMutation({
    mutationFn: endShift,
    onSuccess: (result) => onShiftActionSettled(result, 'end'),
  });

  const [showPushBanner, setShowPushBanner] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    if (!isPushSupported() || localStorage.getItem(PUSH_DISMISSED_KEY) === '1') return;
    getPushSubscriptionState().then((state) => setShowPushBanner(state === 'unsubscribed'));
  }, []);

  async function enablePush() {
    setPushBusy(true);
    try {
      await enablePushNotifications();
      setShowPushBanner(false);
    } catch {
      // Permission denied or unsupported — quietly leave the banner as-is
      // rather than nagging with an error the operator can't act on mid-shift.
    } finally {
      setPushBusy(false);
    }
  }

  function dismissPushBanner() {
    localStorage.setItem(PUSH_DISMISSED_KEY, '1');
    setShowPushBanner(false);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-(--text-tertiary)">Hey, {user?.fullName.split(' ')[0]}</p>
          <h1 className="text-2xl font-bold">Today</h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button className="relative text-sm font-semibold text-accent-500" onClick={() => navigate('/notifications')}>
            Alerts
            {unread > 0 && (
              <span className="absolute -right-3 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-500 px-1 text-[10px] font-bold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          <button className="text-sm font-semibold text-accent-500" onClick={() => navigate('/messages')}>
            Messages
          </button>
          {operatorId && (
            <button
              className="text-sm font-semibold text-accent-500"
              onClick={() => navigate(`/glovebox?operatorId=${operatorId}&operatorName=${encodeURIComponent(user?.fullName ?? '')}`)}
            >
              My Documents
            </button>
          )}
          <button className="text-sm font-semibold text-accent-500" onClick={() => navigate('/forms')}>
            Forms
          </button>
          <button className="text-sm font-semibold text-accent-500" onClick={() => navigate('/help')}>
            Help
          </button>
          <button className="text-sm text-(--text-tertiary) underline" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>

      {showPushBanner && (
        <div className="mx-6 mb-4 flex items-center justify-between gap-3 rounded-2xl border border-accent-500/40 bg-accent-500/10 p-4">
          <p className="text-sm text-(--text-secondary)">Turn on notifications so you don't miss a new job or message.</p>
          <div className="flex shrink-0 items-center gap-3">
            <button className="text-sm text-(--text-tertiary) underline" onClick={dismissPushBanner}>
              Not now
            </button>
            <button
              className="min-h-10 shrink-0 rounded-xl bg-accent-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
              onClick={enablePush}
              disabled={pushBusy}
            >
              {pushBusy ? 'Enabling…' : 'Enable'}
            </button>
          </div>
        </div>
      )}

      {operatorId && !shiftQuery.isError && (
        <div className="mx-6 mb-4 space-y-1">
          <div className="flex items-center justify-between rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
            {shiftQuery.data?.shift?.status === 'ACTIVE' ? (
              <>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-success-500">On shift</p>
                  <p className="text-sm text-(--text-tertiary)">Since {new Date(shiftQuery.data.shift.startedAt).toLocaleTimeString()}</p>
                </div>
                <Button variant="secondary" onClick={() => endShiftMutation.mutate()} disabled={endShiftMutation.isPending}>
                  {endShiftMutation.isPending ? 'Ending…' : 'End shift'}
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-(--text-secondary)">Not on shift</p>
                <Button onClick={() => startShiftMutation.mutate()} disabled={startShiftMutation.isPending}>
                  {startShiftMutation.isPending ? 'Starting…' : 'Start shift'}
                </Button>
              </>
            )}
          </div>
          {shiftSyncNote && <p className="px-1 text-xs text-(--text-tertiary)">{shiftSyncNote}</p>}
        </div>
      )}

      {fatigue && fatigue.status !== 'ok' && fatigue.status !== 'not_assessed' && (
        <div
          className={`mx-6 mb-4 space-y-1.5 rounded-2xl border p-4 ${
            fatigue.status === 'breach' ? 'border-danger-500/40 bg-danger-500/10' : 'border-warning-500/40 bg-warning-500/10'
          }`}
        >
          <p className={`text-xs font-semibold uppercase tracking-wide ${fatigue.status === 'breach' ? 'text-danger-500' : 'text-warning-500'}`}>
            {fatigue.status === 'breach' ? 'Standard Hours limit reached' : 'Approaching a Standard Hours limit'}
          </p>
          {fatigueFlags.map((flag) => (
            <p key={flag.rule} className="text-sm text-(--text-secondary)">
              {flag.message}
            </p>
          ))}
        </div>
      )}

      <div className="flex-1 space-y-4 px-6">
        {!operatorId ? (
          <p className="text-(--text-secondary)">
            This login isn't linked to an Operator record, so there's nothing to show here yet.
          </p>
        ) : isLoading ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full rounded-2xl" />
              <Skeleton className="h-14 w-full rounded-2xl" />
            </div>
          ))
        ) : isError ? (
          <p className="text-danger-500">Couldn't load your jobs. Check your connection.</p>
        ) : data && data.items.length > 0 ? (
          data.items.map((job) => (
            <div key={job.id} className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
              <p className="text-lg font-semibold">{job.title}</p>
              {job.asset && <p className="text-(--text-secondary)">{job.asset.name}</p>}
              {job.pickupDepot && <p className="text-(--text-tertiary)">Pickup: {job.pickupDepot.name}</p>}
              {job.description && <p className="mt-2 text-(--text-tertiary)">{job.description}</p>}

              {job.stops && job.stops.length > 0 && (
                <div className="mt-4 space-y-2">
                  {(() => {
                    const nextStop = job.stops!.find((s) => s.outcome === 'PENDING');
                    if (!nextStop) return null;
                    const isLate = !!nextStop.windowEnd && new Date(nextStop.windowEnd) < new Date();
                    return (
                      <div className="space-y-2">
                        <button onClick={() => navigate(stopUrl(job.id, nextStop))} className="w-full rounded-2xl border-2 border-accent-500 bg-accent-500/10 p-4 text-left">
                          <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">Next stop</p>
                          <p className="mt-1 text-lg font-bold">{nextStop.label}</p>
                          {nextStop.address && <p className="text-(--text-secondary)">{nextStop.address}</p>}
                          {nextStop.windowEnd && (
                            <p className={`text-sm ${isLate ? 'text-danger-500' : 'text-(--text-tertiary)'}`}>
                              Due by {new Date(nextStop.windowEnd).toLocaleString()}
                            </p>
                          )}
                          <p className="mt-2 text-sm font-semibold text-accent-500">Record delivery →</p>
                        </button>
                        {nextStop.address && (
                          <a
                            href={directionsUrl(nextStop.address)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex min-h-12 items-center justify-center rounded-2xl border border-accent-500/40 bg-accent-500/5 text-sm font-semibold text-accent-500"
                          >
                            Navigate to this stop ↗
                          </a>
                        )}
                      </div>
                    );
                  })()}
                  <p className="text-sm text-(--text-tertiary)">
                    Stops · {job.stops.filter((s) => s.outcome !== 'PENDING').length}/{job.stops.length} done
                  </p>
                  {job.stops.map((stop) => {
                    const done = stop.outcome !== 'PENDING';
                    const isLate = stop.outcome === 'PENDING' && !!stop.windowEnd && new Date(stop.windowEnd) < new Date();
                    return (
                      <button
                        key={stop.id}
                        disabled={done}
                        onClick={() => navigate(stopUrl(job.id, stop))}
                        className={`flex w-full items-center gap-3 rounded-xl border border-(--border-subtle) p-3 text-left ${done ? 'opacity-70' : 'bg-(--surface-2)'}`}
                      >
                        <span className="text-sm text-(--text-tertiary)">{stop.sequence}</span>
                        <span className="flex-1">
                          <span className="block font-medium">{stop.label}</span>
                          {stop.address && <span className="block text-sm text-(--text-tertiary)">{stop.address}</span>}
                          {isLate && <span className="block text-sm font-semibold text-danger-500">Overdue</span>}
                        </span>
                        <span
                          className={`text-sm font-semibold ${stop.outcome === 'DELIVERED' ? 'text-success-500' : stop.outcome === 'FAILED' ? 'text-danger-500' : 'text-accent-500'}`}
                        >
                          {stop.outcome === 'DELIVERED' ? 'Delivered' : stop.outcome === 'FAILED' ? 'Failed' : 'Deliver →'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {job.asset && (
                <div className="mt-4 space-y-2">
                  <Button
                    onClick={() => navigate(`/checklist?assetId=${job.asset!.id}&assetName=${encodeURIComponent(job.asset!.name)}`)}
                  >
                    Start pre-start inspection
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => navigate(`/glovebox?assetId=${job.asset!.id}&assetName=${encodeURIComponent(job.asset!.name)}`)}
                  >
                    Digital Glovebox
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => navigate(`/fault-report?assetId=${job.asset!.id}&assetName=${encodeURIComponent(job.asset!.name)}`)}
                  >
                    Report a fault
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => navigate(`/forms?assetId=${job.asset!.id}&assetName=${encodeURIComponent(job.asset!.name)}`)}
                  >
                    Fill out a form
                  </Button>
                  {/* Registration is passed through so the plate field starts
                      pre-filled with the vehicle the driver is actually in. */}
                  <Button
                    variant="secondary"
                    onClick={() =>
                      navigate(
                        `/fuel?assetId=${job.asset!.id}&assetName=${encodeURIComponent(job.asset!.name)}` +
                          (job.asset!.registration ? `&registration=${encodeURIComponent(job.asset!.registration)}` : ''),
                      )
                    }
                  >
                    Record fuel
                  </Button>
                </div>
              )}
            </div>
          ))
        ) : (
          <p className="text-(--text-secondary)">No job assigned to you right now.</p>
        )}
        {data?.fromCache && (
          <p className="text-xs text-(--text-tertiary)">
            Last synced {new Date(data.cachedAt!).toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  );
}
