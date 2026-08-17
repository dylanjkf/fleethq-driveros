import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StopPage } from './StopPage';
import * as jobsApi from '@/api/jobs';
import * as formsApi from '@/api/forms';
import * as parcelsApi from '@/api/parcels';
import type { FormTemplate } from '@/api/types';

/**
 * Configurable, multi-drop proof of delivery (item 3, DriverOS half). When the
 * tenant has an active DELIVERY template, a DELIVERED drop must capture that
 * template's evidence instead of the hardcoded photo/signature. This proves the
 * client-side gate: a required photo blocks submit until captured, and once
 * captured `completeStop` is sent with `evidence.answers` carrying the photo
 * answer — plus `parcelIds` covering every parcel on a multi-parcel stop.
 */

// StatusBar pulls auth/outbox context we don't exercise here.
vi.mock('@/components/ui/StatusBar', () => ({ StatusBar: () => null }));

// jsdom can't decode an image, so the real canvas re-encode never settles.
// Stand in a deterministic compressed result — the capture→base64 wiring is
// what this test proves, not the pixel downscaling (covered by image.ts's own).
vi.mock('@/lib/image', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/image')>()),
  compressImageFile: vi.fn().mockResolvedValue({
    dataUrl: 'data:image/jpeg;base64,QUJD',
    contentType: 'image/jpeg',
    filename: 'shot.jpg',
    bytes: 3,
  }),
}));

const PHOTO_FIELD_ID = 'field-photo-1';
const DELIVERY_TEMPLATE: FormTemplate = {
  id: 'tpl-delivery',
  name: 'Proof of delivery',
  description: null,
  version: 1,
  referenceDocument: null,
  fields: [
    { id: PHOTO_FIELD_ID, label: 'Delivery photo', type: 'photo', required: true, options: null, showIfFieldId: null, showIfValue: null },
  ],
};

function renderStop() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/stop?jobId=J1&stopId=S1&label=Acme']}>
        <StopPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(formsApi, 'getActiveDeliveryFormTemplate').mockResolvedValue(DELIVERY_TEMPLATE);
  // A multi-parcel stop.
  vi.spyOn(parcelsApi, 'getStopParcels').mockResolvedValue({
    parcels: [
      { id: 'P1', reference: 'REF-1', label: null, scannedAt: null },
      { id: 'P2', reference: 'REF-2', label: null, scannedAt: null },
    ],
    scanned: 0,
    total: 2,
  });
  vi.spyOn(jobsApi, 'cacheStopOutcome').mockResolvedValue(undefined);
  vi.spyOn(jobsApi, 'completeStop').mockResolvedValue({ queued: false });
});

describe('StopPage — configurable multi-drop POD', () => {
  it('blocks submit until the required photo AND an unscanned-parcel override, then sends evidence + parcelIds', async () => {
    const user = userEvent.setup();
    const { container } = renderStop();

    // Choose the DELIVERED outcome; the template's evidence field then appears.
    await user.click(screen.getByRole('button', { name: 'Delivered' }));
    await waitFor(() => expect(screen.getByText('Delivery photo')).toBeInTheDocument());
    // Multi-drop hint reflects both parcels.
    expect(screen.getByText(/Covers all 2 parcels/)).toBeInTheDocument();

    // Required photo not captured yet → submit is blocked, no API call.
    await user.click(screen.getByRole('button', { name: 'Save delivery' }));
    expect(screen.getByText(/Capture "Delivery photo" before saving/)).toBeInTheDocument();
    expect(jobsApi.completeStop).not.toHaveBeenCalled();

    // Capture the photo via the hidden file input.
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['\xff\xd8\xff\xe0jpegbytes'], 'shot.jpg', { type: 'image/jpeg' });
    await user.upload(fileInput, file);
    await waitFor(() => expect(screen.getByAltText('Delivery photo')).toBeInTheDocument());

    // Photo is captured, but BOTH parcels are unscanned — the multi-drop guard
    // now blocks a silent zero-scan delivery until the override is acknowledged.
    await user.click(screen.getByRole('button', { name: 'Save delivery' }));
    expect(screen.getByText(/Scan them, or tick "Deliver unscanned"/)).toBeInTheDocument();
    expect(jobsApi.completeStop).not.toHaveBeenCalled();

    // Tick the explicit "Deliver unscanned" override.
    await user.click(screen.getByRole('checkbox'));

    // Now submit succeeds and carries the evidence answer + parcelIds.
    await user.click(screen.getByRole('button', { name: 'Save delivery' }));
    await waitFor(() => expect(jobsApi.completeStop).toHaveBeenCalledTimes(1));

    const [jobId, stopId, input] = vi.mocked(jobsApi.completeStop).mock.calls[0];
    expect(jobId).toBe('J1');
    expect(stopId).toBe('S1');
    expect(input.outcome).toBe('DELIVERED');
    expect(input.parcelIds).toEqual(['P1', 'P2']);
    // Legacy hardcoded POD fields are NOT sent when a DELIVERY template is active.
    expect(input.podPhotoBase64).toBeUndefined();
    expect(input.evidence?.answers).toHaveLength(1);
    const answer = input.evidence!.answers[0];
    expect(answer.fieldId).toBe(PHOTO_FIELD_ID);
    const value = answer.value as { contentType: string; filename: string; base64: string };
    expect(value.contentType).toBe('image/jpeg');
    expect(value.base64.length).toBeGreaterThan(0);
    expect(value.base64.startsWith('data:')).toBe(false); // bare payload, not a data URL
  });

  it('a stop whose parcels are all already scanned needs no override and submits directly', async () => {
    // Both parcels arrive already scanned — no unconfirmed items, so no override
    // gate and no override checkbox.
    vi.spyOn(parcelsApi, 'getStopParcels').mockResolvedValue({
      parcels: [
        { id: 'P1', reference: 'REF-1', label: null, scannedAt: '2026-08-12T00:00:00Z' },
        { id: 'P2', reference: 'REF-2', label: null, scannedAt: '2026-08-12T00:00:00Z' },
      ],
      scanned: 2,
      total: 2,
    });
    const user = userEvent.setup();
    const { container } = renderStop();

    await user.click(screen.getByRole('button', { name: 'Delivered' }));
    await waitFor(() => expect(screen.getByText('Delivery photo')).toBeInTheDocument());
    // No override control — nothing is unconfirmed.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['\xff\xd8\xff\xe0jpegbytes'], 'shot.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(screen.getByAltText('Delivery photo')).toBeInTheDocument());

    // Submits straight away — no override needed.
    await user.click(screen.getByRole('button', { name: 'Save delivery' }));
    await waitFor(() => expect(jobsApi.completeStop).toHaveBeenCalledTimes(1));
    expect(vi.mocked(jobsApi.completeStop).mock.calls[0][2].outcome).toBe('DELIVERED');
  });
});
