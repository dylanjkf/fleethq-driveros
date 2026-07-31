import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { getApplicableFormTemplates } from '@/api/forms';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusBar } from '@/components/ui/StatusBar';
import { useAuth } from '@/hooks/useAuth';
import { FormRunner } from './FormRunner';
import type { FormTemplate } from '@/api/types';

/**
 * Universal Forms on DriverOS (01-Product/Universal_Forms.md): incident
 * reports, custom inspections, anything the office built beyond the standard
 * checklist. Reachable standalone from Today (general forms — e.g. an
 * incident report filed anytime) or from a job via the same `?assetId=&
 * assetName=` params Checklist/Glovebox/Fault Reporting use, which is what
 * lets an asset_ref field in the form resolve automatically.
 */
export function FormsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const assetId = searchParams.get('assetId');
  const assetName = searchParams.get('assetName');
  const [selected, setSelected] = useState<FormTemplate | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['form-templates'],
    queryFn: getApplicableFormTemplates,
    staleTime: 60_000,
  });

  const templates = data?.items ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="px-6 py-5">
        <button
          className="mb-2 text-sm text-(--text-tertiary) underline"
          onClick={() => (selected ? setSelected(null) : navigate('/'))}
        >
          ← Back
        </button>
        <h1 className="text-2xl font-bold">{selected ? selected.name : 'Forms'}</h1>
        {selected && assetName && <p className="text-(--text-secondary)">{assetName}</p>}
      </div>

      {confirmation ? (
        <p className="px-6 text-lg text-success-500">{confirmation}</p>
      ) : selected ? (
        <FormRunner
          template={selected}
          assetId={assetId}
          assetName={assetName}
          operatorId={user?.operator?.id ?? null}
          operatorName={user?.fullName ?? null}
          onDone={(message) => {
            setConfirmation(message);
            setTimeout(() => navigate('/'), 1500);
          }}
        />
      ) : isLoading ? (
        <div className="flex-1 space-y-3 px-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2 rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p className="px-6 text-danger-500">Couldn't load forms. Check your connection.</p>
      ) : templates.length === 0 ? (
        <p className="px-6 text-(--text-secondary)">No forms are set up for you yet.</p>
      ) : (
        <div className="flex-1 space-y-3 px-6">
          {templates.map((template) => (
            <button
              key={template.id}
              onClick={() => setSelected(template)}
              className="min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5 text-left"
            >
              <p className="text-lg font-semibold">{template.name}</p>
              {template.description && <p className="text-(--text-tertiary)">{template.description}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
