import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSyncClockOffset,
  observeServerClock,
  setSyncClockOffset,
  syncNow,
} from '@/services/sync/clock';

/**
 * The sync protocol orders records by wall clock, and one side of every
 * comparison is a timestamp the sync server stamped. A device whose clock runs
 * ahead therefore writes records that always outrank the server's cursor: the
 * library sync re-pushes forever (the 5-second storm) and a peer whose clock is
 * honest loses every merge. `syncNow()` is the corrected clock the stamping
 * sites use; these tests pin how the correction is measured and applied.
 */

const TEN_MINUTES = 10 * 60 * 1000;

afterEach(() => {
  setSyncClockOffset(0);
  vi.restoreAllMocks();
});

describe('syncNow', () => {
  it('shifts the device clock by the measured gap', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    // This device reads 104,300 where the server read 100,000.
    setSyncClockOffset(-4_300);

    expect(syncNow()).toBe(95_700);
  });

  it('is the device clock while no sample has been taken', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);

    expect(syncNow()).toBe(100_000);
  });
});

describe('observeServerClock', () => {
  it('records the gap a fresh server stamp reveals', () => {
    expect(observeServerClock(100_000, 104_300)).toBe(true);
    expect(getSyncClockOffset()).toBe(-4_300);
  });

  it('records a device clock running behind, too', () => {
    expect(observeServerClock(200_000, 195_700)).toBe(true);
    expect(getSyncClockOffset()).toBe(4_300);
  });

  it('rejects a sample that would imply an implausible gap', () => {
    // Not skew: a row the server wrote long ago, surfaced by a delta pull.
    setSyncClockOffset(-1_000);

    expect(observeServerClock(100_000, 100_000 + TEN_MINUTES + 1)).toBe(false);
    expect(getSyncClockOffset()).toBe(-1_000);
  });

  it('rejects a row with no readable server stamp', () => {
    expect(observeServerClock(new Date('not a date').getTime(), Date.now())).toBe(false);
    expect(getSyncClockOffset()).toBe(0);
  });
});

describe('setSyncClockOffset', () => {
  it('keeps a measured gap when nothing was persisted', () => {
    setSyncClockOffset(-2_000);

    setSyncClockOffset(undefined);
    expect(getSyncClockOffset()).toBe(-2_000);
  });

  it('ignores a persisted value outside the trusted range', () => {
    setSyncClockOffset(TEN_MINUTES * 2);
    expect(getSyncClockOffset()).toBe(0);
  });
});
