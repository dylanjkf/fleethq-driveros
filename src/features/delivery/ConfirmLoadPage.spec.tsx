import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfirmLoadPage } from './ConfirmLoadPage';
import type { LoadStatus } from '@/api/load';

/**
 * The "Confirm load" screen's job (item 2): surface a discrepancy when a
 * manifest item isn't scanned/confirmed, and NEVER let the run start on that
 * partial load without an explicit "Proceed anyway" — which must call the
 * verification endpoint with the override flag + the missing references. A clean
 * load confirms with no override. These tests drive the real component with the
 * load API mocked.
 */
const getLoadStatus = vi.hoisted(() => vi.fn());
const verifyLoad = vi.hoisted(() => vi.fn());
const cacheLoadStatus = vi.hoisted(() => vi.fn());
vi.mock('@/api/load', () => ({ getLoadStatus, verifyLoad, cacheLoadStatus }));
// The shared scan path is exercised by its own spec; here it's a no-op so the
// screen's discrepancy/override logic is what's under test.
vi.mock('./scan-submit', () => ({ submitScannedReference: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/barcode-scanner', () => ({ scanBarcodeWithCamera: vi.fn() }));
// StatusBar reaches for AuthProvider/network context we don't need here.
vi.mock('@/components/ui/StatusBar', () => ({ StatusBar: () => null }));

function statusWithMissing(): LoadStatus {
  return {
    jobId: 'job-1',
    stops: [
      {
        stopId: 'stop-1',
        label: 'Stop A',
        parcels: [
          { id: 'p1', reference: 'A-1', scannedAt: '2026-08-12T00:00:00Z' },
          { id: 'p2', reference: 'A-2', scannedAt: null },
        ],
        scannedCount: 1,
        expectedCount: 2,
      },
    ],
    expectedTotal: 2,
    scannedTotal: 1,
    discrepancies: [{ stopId: 'stop-1', stopLabel: 'Stop A', parcelId: 'p2', reference: 'A-2' }],
    loadVerifiedAt: null,
  };
}

function cleanStatus(): LoadStatus {
  return {
    jobId: 'job-1',
    stops: [
      {
        stopId: 'stop-1',
        label: 'Stop A',
        parcels: [{ id: 'p1', reference: 'A-1', scannedAt: '2026-08-12T00:00:00Z' }],
        scannedCount: 1,
        expectedCount: 1,
      },
    ],
    expectedTotal: 1,
    scannedTotal: 1,
    discrepancies: [],
    loadVerifiedAt: null,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/confirm-load?jobId=job-1&title=Load%20run']}>
        <ConfirmLoadPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ConfirmLoadPage — discrepancy + proceed-anyway', () => {
  beforeEach(() => {
    getLoadStatus.mockReset();
    verifyLoad.mockReset();
    cacheLoadStatus.mockReset();
    cacheLoadStatus.mockResolvedValue(undefined);
    verifyLoad.mockResolvedValue({ queued: false });
  });

  it('persists an optimistic scan to the offline cache so it survives a restart (Part 3)', async () => {
    // First mount: A-2 is missing. The reconcile refetch fails (offline), so the
    // optimistic scan must stay — and must have been written to the offline cache.
    getLoadStatus.mockResolvedValueOnce(statusWithMissing()).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('1 item not confirmed loaded');
    await user.type(screen.getByPlaceholderText('Scan or enter parcel barcode'), 'A-2');
    await user.click(screen.getByRole('button', { name: 'Scan' }));

    // The optimistic status was persisted with A-2 now scanned — that cache is
    // what an offline restart reloads (proven end-to-end in api/load.spec.ts).
    await waitFor(() => expect(cacheLoadStatus).toHaveBeenCalledTimes(1));
    const cached = cacheLoadStatus.mock.calls[0][0] as LoadStatus;
    expect(cached.stops[0].parcels.find((p) => p.reference === 'A-2')?.scannedAt).toBeTruthy();
  });

  it('shows the discrepancy and offers Proceed anyway (no clean confirm)', async () => {
    getLoadStatus.mockResolvedValue(statusWithMissing());
    renderPage();

    expect(await screen.findByText('1 item not confirmed loaded')).toBeInTheDocument();
    // The missing reference is listed.
    expect(screen.getByText('A-2', { selector: 'li' })).toBeInTheDocument();
    // The clean confirm is NOT offered while a discrepancy stands.
    expect(screen.queryByText('Confirm load & start')).not.toBeInTheDocument();
    expect(screen.getByText('Proceed anyway')).toBeInTheDocument();
  });

  it('Proceed anyway calls verifyLoad with the override flag and the missing references', async () => {
    getLoadStatus.mockResolvedValue(statusWithMissing());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Proceed anyway'));

    await waitFor(() => expect(verifyLoad).toHaveBeenCalledTimes(1));
    expect(verifyLoad).toHaveBeenCalledWith('job-1', {
      confirm: true,
      override: true,
      missingReferences: ['A-2'],
    });
    expect(await screen.findByText(/discrepancy recorded/)).toBeInTheDocument();
  });

  it('a clean load confirms WITHOUT an override', async () => {
    getLoadStatus.mockResolvedValue(cleanStatus());
    const user = userEvent.setup();
    renderPage();

    const confirm = await screen.findByText('Confirm load & start');
    // No discrepancy panel.
    expect(screen.queryByText('Proceed anyway')).not.toBeInTheDocument();

    await user.click(confirm);
    await waitFor(() => expect(verifyLoad).toHaveBeenCalledTimes(1));
    expect(verifyLoad).toHaveBeenCalledWith('job-1', {
      confirm: true,
      override: undefined,
      missingReferences: undefined,
    });
  });
});
