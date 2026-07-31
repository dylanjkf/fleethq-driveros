import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { getThread, sendMessage } from '@/api/messages';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusBar } from '@/components/ui/StatusBar';
import { ApiClientError } from '@/api/client';

interface PendingMessage {
  tempId: string;
  body: string;
}

/**
 * DriverOS messaging v0 (04-DriverOS/DriverOS_Overview.md): the operator's own
 * thread with the office, replacing the "what's next" phone call. Reads
 * network-first-then-cache so the last thread stays visible offline; a message
 * sent offline is shown immediately as "Sending…" and queued to the outbox,
 * then reconciled against the server once a fresh fetch lands.
 */
export function MessagesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['messages-thread'],
    queryFn: getThread,
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  // Once a fresh (non-cache) thread lands, the server is the source of truth —
  // drop the optimistic pending copies it now contains.
  useEffect(() => {
    if (data && !data.fromCache) setPending([]);
  }, [data]);

  const messages = data?.thread.items ?? [];
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, pending.length]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setError(null);
    setDraft('');
    const tempId = crypto.randomUUID();
    setPending((p) => [...p, { tempId, body }]);
    try {
      const result = await sendMessage(body);
      if (!result.queued) {
        await queryClient.invalidateQueries({ queryKey: ['messages-thread'] });
      }
    } catch (err) {
      setPending((p) => p.filter((m) => m.tempId !== tempId));
      setDraft(body);
      setError(err instanceof ApiClientError ? err.message : 'Could not send. Try again.');
    }
  }

  return (
    <div className="flex h-[100svh] flex-col">
      <StatusBar />
      <div className="flex items-center gap-3 px-6 py-4">
        <button className="text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>
          ← Back
        </button>
        <h1 className="text-xl font-bold">Messages</h1>
        <span className="ml-auto text-sm text-(--text-tertiary)">Office</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-6 py-2">
        {isLoading ? (
          <>
            <div className="flex justify-start">
              <Skeleton className="h-12 w-2/3 rounded-2xl" />
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-10 w-1/2 rounded-2xl" />
            </div>
            <div className="flex justify-start">
              <Skeleton className="h-16 w-3/4 rounded-2xl" />
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-10 w-2/5 rounded-2xl" />
            </div>
          </>
        ) : isError ? (
          <p className="text-danger-500">Couldn't load messages. Check your connection.</p>
        ) : messages.length === 0 && pending.length === 0 ? (
          <p className="text-(--text-secondary)">No messages yet. Send the office a message below.</p>
        ) : (
          <>
            {messages.map((m) => (
              <Bubble key={m.id} mine={m.senderType === 'OPERATOR'} body={m.body} meta={formatTime(m.createdAt)} />
            ))}
            {pending.map((m) => (
              <Bubble key={m.tempId} mine body={m.body} meta="Sending…" pending />
            ))}
          </>
        )}
        <div ref={endRef} />
      </div>

      {error && <p className="px-6 text-sm text-danger-500">{error}</p>}

      <form onSubmit={handleSend} className="flex items-end gap-2 px-4 py-3">
        <textarea
          className="max-h-32 min-h-14 flex-1 resize-none rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 py-3 text-base"
          placeholder="Message the office…"
          value={draft}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="min-h-14 rounded-2xl bg-accent-600 px-5 font-semibold text-white disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function Bubble({ mine, body, meta, pending }: { mine: boolean; body: string; meta: string; pending?: boolean }) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
          mine ? 'bg-accent-600 text-white' : 'bg-(--surface-1) text-(--text-primary)'
        } ${pending ? 'opacity-60' : ''}`}
      >
        <p className="whitespace-pre-wrap text-[15px] leading-snug">{body}</p>
        <p className={`mt-1 text-[11px] ${mine ? 'text-white/70' : 'text-(--text-tertiary)'}`}>{meta}</p>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
