import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { getApplicableTemplates } from '@/api/checklists';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusBar } from '@/components/ui/StatusBar';
import { ChecklistRunner } from './ChecklistRunner';
import type { ChecklistTemplate } from '@/api/types';

/**
 * Smart Checklists on DriverOS (01-Product/Smart_Checklists.md): the operator
 * opens today's pre-start checklist for the asset they're on, answers it top to
 * bottom, and submits. Reached from Today via the same `?assetId=&assetName=`
 * params Fault Reporting and Digital Glovebox use. If more than one checklist
 * applies to the asset, the operator picks; otherwise it opens straight into the
 * one that applies.
 */
export function ChecklistPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const assetId = searchParams.get('assetId');
  const assetName = searchParams.get('assetName');
  const [selected, setSelected] = useState<ChecklistTemplate | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['checklist-templates', assetId],
    queryFn: () => getApplicableTemplates(assetId!),
    enabled: !!assetId,
    staleTime: 60_000,
  });

  if (!assetId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-(--text-secondary)">
          Open this from your assigned job on Today so it runs against the right asset.
        </p>
        <Button variant="secondary" onClick={() => navigate('/')}>
          Back to Today
        </Button>
      </div>
    );
  }

  const templates = data?.items ?? [];
  const active = selected ?? (templates.length === 1 ? templates[0] : null);

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="px-6 py-5">
        <button
          className="mb-2 text-sm text-(--text-tertiary) underline"
          onClick={() => (active && !selected ? navigate('/') : selected ? setSelected(null) : navigate('/'))}
        >
          ← Back
        </button>
        <h1 className="text-2xl font-bold">{active ? active.name : 'Pre-start inspection'}</h1>
        {assetName && <p className="text-(--text-secondary)">{assetName}</p>}
      </div>

      {confirmation ? (
        <p className="px-6 text-lg text-success-500">{confirmation}</p>
      ) : isLoading ? (
        <div className="flex-1 space-y-3 px-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2 rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p className="px-6 text-danger-500">Couldn't load your inspections. Check your connection.</p>
      ) : active ? (
        <ChecklistRunner
          template={active}
          assetId={assetId}
          assetName={assetName}
          onDone={(message) => {
            setConfirmation(message);
            setTimeout(() => navigate('/'), 1500);
          }}
        />
      ) : templates.length === 0 ? (
        <p className="px-6 text-(--text-secondary)">No inspection is set up for this asset yet.</p>
      ) : (
        <div className="flex-1 space-y-3 px-6">
          {templates.map((template) => (
            <button
              key={template.id}
              onClick={() => setSelected(template)}
              className="min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5 text-left"
            >
              <p className="text-lg font-semibold">{template.name}</p>
              <p className="text-(--text-tertiary)">{template.items.length} checks</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
