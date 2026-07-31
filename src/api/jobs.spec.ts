import { describe, expect, it } from 'vitest';
import { applyStopOutcome } from './jobs';
import type { Job } from './types';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Morning run',
    description: null,
    status: 'ASSIGNED',
    asset: null,
    pickupDepot: null,
    stops: [
      { id: 'stop-1', sequence: 1, label: 'Drop A', address: null, windowEnd: null, outcome: 'PENDING' },
      { id: 'stop-2', sequence: 2, label: 'Drop B', address: null, windowEnd: null, outcome: 'PENDING' },
    ],
    ...overrides,
  } as Job;
}

/**
 * This transform is the whole reason a stop completed in a dead zone stops
 * showing "Deliver →" — it updates the cached list where a refetch can't. If it
 * mutated the wrong stop, touched the wrong job, or mutated its inputs, the
 * offline board would lie. So it's pinned directly.
 */
describe('applyStopOutcome', () => {
  it('marks only the named stop, in the named job, as completed', () => {
    const result = applyStopOutcome([job()], 'job-1', 'stop-1', 'DELIVERED');
    expect(result[0].stops!.find((s) => s.id === 'stop-1')!.outcome).toBe('DELIVERED');
    expect(result[0].stops!.find((s) => s.id === 'stop-2')!.outcome).toBe('PENDING');
  });

  it('stamps a completion time so the office sees the real delivery moment', () => {
    const result = applyStopOutcome([job()], 'job-1', 'stop-1', 'FAILED');
    expect(result[0].stops!.find((s) => s.id === 'stop-1')!.completedAt).toBeTruthy();
  });

  it('leaves other jobs untouched', () => {
    const other = job({ id: 'job-2' });
    const result = applyStopOutcome([job(), other], 'job-1', 'stop-1', 'DELIVERED');
    expect(result[1].stops!.every((s) => s.outcome === 'PENDING')).toBe(true);
  });

  it('does not mutate its input (React state safety)', () => {
    const input = [job()];
    const before = JSON.stringify(input);
    applyStopOutcome(input, 'job-1', 'stop-1', 'DELIVERED');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is a no-op for an unknown job or stop rather than throwing', () => {
    expect(() => applyStopOutcome([job()], 'nope', 'stop-1', 'DELIVERED')).not.toThrow();
    expect(applyStopOutcome([job()], 'job-1', 'nope', 'DELIVERED')[0].stops!.every((s) => s.outcome === 'PENDING')).toBe(
      true,
    );
  });
});
