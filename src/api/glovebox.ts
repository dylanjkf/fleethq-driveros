import { apiClient } from './client';
import { getCache, setCache } from '@/lib/offline-db';
import type { ComplianceDocument } from './types';

export interface GloveboxResult {
  asset: { id: string; name: string; emergencyContact: string | null };
  documents: ComplianceDocument[];
  fromCache: boolean;
  cachedAt?: number;
}

export interface OperatorGloveboxResult {
  operator: { id: string; fullName: string };
  documents: ComplianceDocument[];
  fromCache: boolean;
  cachedAt?: number;
}

function cacheKey(assetId: string): string {
  return `glovebox-${assetId}`;
}

function operatorCacheKey(operatorId: string): string {
  return `glovebox-operator-${operatorId}`;
}

/**
 * Digital Glovebox v0 (01-Product/Digital_Glovebox.md): the current job's
 * asset's compliance document status and emergency contact. Same
 * network-first-then-cache pattern as Today's job list (`api/jobs.ts`) — the
 * spec's edge case explicitly requires previously-synced documents to remain
 * viewable offline.
 */
export async function getGlovebox(assetId: string): Promise<GloveboxResult> {
  try {
    const { data } = await apiClient.get<Omit<GloveboxResult, 'fromCache' | 'cachedAt'>>(
      `/v1/assets/${assetId}/glovebox`,
    );
    await setCache(cacheKey(assetId), data);
    return { ...data, fromCache: false };
  } catch (err) {
    const cached = await getCache<Omit<GloveboxResult, 'fromCache' | 'cachedAt'>>(cacheKey(assetId));
    if (cached) {
      return { ...cached.data, fromCache: true, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}

/**
 * Open a glovebox document's scanned file in a new tab. Served from the
 * asset/operator glovebox route (gated on the same permission the driver already
 * used to see the glovebox), so no blanket attachments access is needed.
 *
 * Not cached for offline use — it's an arbitrary, potentially large scan, and
 * the status/number/expiry the driver actually relies on roadside are already
 * cached. Offline this throws; the caller surfaces "needs a connection" rather
 * than pretending. Same deliberate stance as the form reference document.
 */
export async function openGloveboxDocument(
  scope: { assetId: string } | { operatorId: string },
  documentId: string,
): Promise<void> {
  const base = 'assetId' in scope ? `/v1/assets/${scope.assetId}` : `/v1/operators/${scope.operatorId}`;
  const { data } = await apiClient.get<Blob>(`${base}/glovebox/documents/${documentId}/file`, { responseType: 'blob' });
  const url = URL.createObjectURL(data);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Operator-scoped Glovebox: the operator's own licence/medical certificate status. Same cache-fallback pattern as getGlovebox. */
export async function getOperatorGlovebox(operatorId: string): Promise<OperatorGloveboxResult> {
  try {
    const { data } = await apiClient.get<Omit<OperatorGloveboxResult, 'fromCache' | 'cachedAt'>>(
      `/v1/operators/${operatorId}/glovebox`,
    );
    await setCache(operatorCacheKey(operatorId), data);
    return { ...data, fromCache: false };
  } catch (err) {
    const cached = await getCache<Omit<OperatorGloveboxResult, 'fromCache' | 'cachedAt'>>(operatorCacheKey(operatorId));
    if (cached) {
      return { ...cached.data, fromCache: true, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}
