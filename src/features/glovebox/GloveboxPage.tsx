import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { getGlovebox, getOperatorGlovebox, openGloveboxDocument } from '@/api/glovebox';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusBar } from '@/components/ui/StatusBar';
import type { ComplianceDocument, ComplianceExpiryStatus } from '@/api/types';

type GloveboxScope = { assetId: string } | { operatorId: string };

const DOCUMENT_LABELS: Record<ComplianceDocument['documentType'], string> = {
  REGISTRATION: 'Registration',
  INSURANCE: 'Insurance',
  ROADWORTHY: 'Roadworthy',
  LICENCE: 'Licence',
  MEDICAL_CERTIFICATE: 'Medical certificate',
};

const STATUS_STYLES: Record<ComplianceExpiryStatus, string> = {
  valid: 'text-success-500',
  expiring_soon: 'text-warning-500',
  expired: 'text-danger-500',
};

const STATUS_LABELS: Record<ComplianceExpiryStatus, string> = {
  valid: 'Valid',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
};

function DocumentList({
  documents,
  emptyMessage,
  scope,
}: {
  documents: ComplianceDocument[];
  emptyMessage: string;
  scope: GloveboxScope;
}) {
  // Which document's scan is currently being fetched, and any open error — the
  // scan needs a connection, so we say so honestly rather than failing silently.
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  if (documents.length === 0) return <p className="text-(--text-secondary)">{emptyMessage}</p>;

  async function view(documentId: string) {
    setErrorId(null);
    setOpeningId(documentId);
    try {
      await openGloveboxDocument(scope, documentId);
    } catch {
      setErrorId(documentId);
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <>
      {documents.map((doc) => (
        <div key={doc.id} className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
          <div className="flex items-center justify-between">
            <p className="text-lg font-semibold">{DOCUMENT_LABELS[doc.documentType]}</p>
            <p className={`font-semibold ${STATUS_STYLES[doc.expiryStatus]}`}>{STATUS_LABELS[doc.expiryStatus]}</p>
          </div>
          {doc.documentNumber && <p className="text-(--text-secondary)">No. {doc.documentNumber}</p>}
          <p className="text-(--text-tertiary)">Expires {new Date(doc.expiresAt).toLocaleDateString()}</p>
          {doc.fileAttachment && (
            <button
              type="button"
              onClick={() => void view(doc.id)}
              disabled={openingId === doc.id}
              className="mt-3 flex min-h-11 w-full items-center justify-center rounded-xl border border-accent-500/40 bg-accent-500/5 text-sm font-semibold text-accent-500 disabled:opacity-60"
            >
              {openingId === doc.id ? 'Opening…' : 'View scan ↗'}
            </button>
          )}
          {errorId === doc.id && (
            <p className="mt-2 text-sm text-danger-500">Couldn&apos;t open the scan — you may be offline.</p>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * Digital Glovebox v0 (01-Product/Digital_Glovebox.md): "Operator taps
 * Digital Glovebox on DriverOS → sees current registration, insurance, and
 * roadworthy status for the asset they're currently assigned to, plus
 * emergency contacts." Reached via `?assetId=&assetName=` from Today's job.
 * Extended to also show the operator's OWN documents (licence, medical
 * certificate) via `?operatorId=&operatorName=`, reached from Today's "My
 * Documents" link — the two modes are mutually exclusive, never both.
 */
export function GloveboxPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const assetId = searchParams.get('assetId');
  const assetName = searchParams.get('assetName');
  const operatorId = searchParams.get('operatorId');
  const operatorName = searchParams.get('operatorName');

  const assetQuery = useQuery({
    queryKey: ['glovebox', assetId],
    queryFn: () => getGlovebox(assetId!),
    enabled: !!assetId,
    staleTime: 60_000,
  });
  const operatorQuery = useQuery({
    queryKey: ['glovebox', 'operator', operatorId],
    queryFn: () => getOperatorGlovebox(operatorId!),
    enabled: !!operatorId,
    staleTime: 60_000,
  });

  if (!assetId && !operatorId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-(--text-secondary)">
          Open this from your assigned job, or "My Documents" on Today, so it shows the right documents.
        </p>
        <button className="text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>
          Back to Today
        </button>
      </div>
    );
  }

  const isLoading = assetId ? assetQuery.isLoading : operatorQuery.isLoading;
  const isError = assetId ? assetQuery.isError : operatorQuery.isError;
  const fromCache = assetId ? assetQuery.data?.fromCache : operatorQuery.data?.fromCache;
  const cachedAt = assetId ? assetQuery.data?.cachedAt : operatorQuery.data?.cachedAt;

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="px-6 py-5">
        <button className="mb-2 text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>
          ← Back
        </button>
        <h1 className="text-2xl font-bold">Digital Glovebox</h1>
        {assetName && <p className="text-(--text-secondary)">{assetName}</p>}
        {operatorName && <p className="text-(--text-secondary)">{operatorName} — my documents</p>}
      </div>

      <div className="flex-1 space-y-3 px-6">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
              <div className="flex items-center justify-between">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-5 w-16" />
              </div>
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))
        ) : isError ? (
          <p className="text-danger-500">Couldn't load these documents. Check your connection.</p>
        ) : assetId ? (
          <>
            <div className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-5">
              <p className="text-sm text-(--text-tertiary)">Emergency contact</p>
              <p className="text-lg font-semibold">{assetQuery.data?.asset.emergencyContact ?? 'Not set'}</p>
            </div>
            <DocumentList
              documents={assetQuery.data?.documents ?? []}
              emptyMessage="No compliance documents logged for this asset yet."
              scope={{ assetId: assetId! }}
            />
          </>
        ) : (
          <DocumentList
            documents={operatorQuery.data?.documents ?? []}
            emptyMessage="No compliance documents logged for you yet."
            scope={{ operatorId: operatorId! }}
          />
        )}
        {fromCache && cachedAt && (
          <p className="text-xs text-(--text-tertiary)">Last synced {new Date(cachedAt).toLocaleTimeString()}</p>
        )}
      </div>
    </div>
  );
}
