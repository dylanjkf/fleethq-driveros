import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { getSupportInfo } from '@/api/companies';
import { Button } from '@/components/ui/Button';
import { StatusBar } from '@/components/ui/StatusBar';

/**
 * 01-Product/Support_Help_Pathway.md: FOUNDER_NOTES.md's "if an operator is
 * stuck mid-shift, what's the actual path to help" gap. Messages is the
 * primary path (already offline-outbox-backed); the company-configured
 * phone number is the fallback for when that isn't fast enough — a tel:
 * link works with zero app connectivity at all, unlike everything else here.
 */
export function HelpPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['support-info'], queryFn: getSupportInfo });

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="flex items-center gap-3 px-6 py-4">
        <button className="text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>← Back</button>
        <h1 className="text-xl font-bold">Get help</h1>
      </div>

      <div className="flex-1 space-y-4 px-6 pb-8">
        <div className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
          <p className="text-lg font-semibold">Message the office</p>
          <p className="mt-1 text-(--text-secondary)">The fastest way to reach dispatch — works offline too, it'll send once you're back online.</p>
          <div className="mt-4">
            <Button onClick={() => navigate('/messages')}>Open Messages</Button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-(--text-tertiary)">Loading…</p>
        ) : data?.supportPhone ? (
          <div className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
            <p className="text-lg font-semibold">Call the office</p>
            <p className="mt-1 text-(--text-secondary)">If you need to speak to someone right now.</p>
            {data.supportNotes && <p className="mt-2 text-sm text-(--text-tertiary)">{data.supportNotes}</p>}
            <div className="mt-4">
              <Button variant="secondary" onClick={() => { window.location.href = `tel:${data.supportPhone}`; }}>
                Call {data.supportPhone}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-(--text-tertiary)">No support phone number has been set up by your company yet.</p>
        )}
      </div>
    </div>
  );
}
