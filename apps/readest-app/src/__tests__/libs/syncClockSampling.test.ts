import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the server-clock gap is measured: every books pull carries rows the
 * server itself stamped with `synced_at`, and the newest one is a reading of the
 * server's clock taken a request ago. Sampling it from the payload needs no
 * extra endpoint and works over any transport (Tauri, webview, web).
 */

vi.mock('@/utils/access', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/services/environment', () => ({ getAPIBaseUrl: () => 'http://server.test/api' }));
vi.mock('@/utils/fetch', () => ({ fetchWithTimeout: vi.fn() }));

const { SyncClient } = await import('@/libs/sync');
const { getSyncClockOffset, setSyncClockOffset } = await import('@/services/sync/clock');
const { fetchWithTimeout } = await import('@/utils/fetch');

const respond = (body: unknown) => {
  vi.mocked(fetchWithTimeout).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
};

beforeEach(() => {
  vi.mocked(fetchWithTimeout).mockReset();
  setSyncClockOffset(0);
  // The device reads 104,300 where the server reads 100,000.
  vi.spyOn(Date, 'now').mockReturnValue(104_300);
});

afterEach(() => {
  setSyncClockOffset(0);
  vi.restoreAllMocks();
});

describe('SyncClient.pullChanges clock sampling', () => {
  it('takes the gap from the newest synced_at in the response', async () => {
    respond({
      books: [
        { book_hash: 'a', synced_at: new Date(90_000).toISOString() },
        { book_hash: 'b', synced_at: new Date(100_000).toISOString() },
      ],
    });

    await new SyncClient().pullChanges(0, 'books');

    expect(getSyncClockOffset()).toBe(-4_300);
  });

  it('leaves the last known gap alone when nothing carries a server stamp', async () => {
    setSyncClockOffset(-4_300);
    respond({ configs: [{ book_hash: 'a', updated_at: new Date(50_000).toISOString() }] });

    await new SyncClient().pullChanges(0, 'configs');

    expect(getSyncClockOffset()).toBe(-4_300);
  });

  it('ignores a row the server wrote too long ago to be a measurement', async () => {
    setSyncClockOffset(-4_300);
    respond({
      books: [{ book_hash: 'a', synced_at: new Date(100_000 - 60 * 60 * 1000).toISOString() }],
    });

    await new SyncClient().pullChanges(0, 'books');

    expect(getSyncClockOffset()).toBe(-4_300);
  });

  it('ignores a row that was written before this request, however recent', async () => {
    // A quiet library: the delta still carries the last write, 30s old. Read as
    // a clock sample it would say "we are 30s ahead", which is inside the
    // trusted range but not a measurement of anything — every stamp would then
    // land behind the server's cursor, so this device would lose each merge and
    // its own change would miss the push gate.
    setSyncClockOffset(-4_300);
    respond({ books: [{ book_hash: 'a', synced_at: new Date(104_300 - 30_000).toISOString() }] });

    await new SyncClient().pullChanges(0, 'books');

    expect(getSyncClockOffset()).toBe(-4_300);
  });

  it('bootstraps from serverTimeMs when the device leads by more than the freshness window', async () => {
    // The device reads 104_300 where the server reads 74_300 — 30s fast. A
    // `synced_at` sample cannot self-start here: its apparent 30s "age" is
    // exactly what a row written 30s ago looks like. The explicit server
    // stamp has no such ambiguity.
    respond({ serverTimeMs: 74_300, books: [] });

    await new SyncClient().pullChanges(0, 'books');

    expect(getSyncClockOffset()).toBe(-30_000);
  });

  it('prefers serverTimeMs over a stale synced_at row', async () => {
    respond({
      serverTimeMs: 100_000,
      books: [{ book_hash: 'a', synced_at: new Date(90_000).toISOString() }],
    });

    await new SyncClient().pullChanges(0, 'books');

    expect(getSyncClockOffset()).toBe(-4_300);
  });

  it('measures synced_at age on the corrected clock for a lagging device', async () => {
    // This device is 60s behind: offset +60_000, so syncNow() reads 164_300 on
    // the server's clock. A row stamped 100_000 looks fresh to Date.now()
    // (104_300 - 100_000 = 4_300) but is 64s old in the server's domain.
    setSyncClockOffset(60_000);
    respond({ books: [{ book_hash: 'a', synced_at: new Date(100_000).toISOString() }] });

    await new SyncClient().pullChanges(0, 'books');

    expect(getSyncClockOffset()).toBe(60_000);
  });

  it('rejects a synced_at dated in the future', async () => {
    respond({ books: [{ book_hash: 'a', synced_at: new Date(120_000).toISOString() }] });

    await new SyncClient().pullChanges(0, 'books');

    expect(getSyncClockOffset()).toBe(0);
  });
});
