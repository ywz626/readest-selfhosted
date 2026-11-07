/**
 * One clock for the sync protocol.
 *
 * Books, configs and notes are last-writer-wins on `updated_at`, and the books
 * pull cursor is the server's `synced_at` — so a record's timestamp is compared
 * against clocks it never shares a source with: this device's wall clock vs the
 * server's, and (through the cloud) vs a peer device's wall clock. A device
 * whose clock leads has its records judged newer no matter when it last read,
 * and it drags two failures along with it:
 *
 * - `useBooksSync.getNewBooks` finds `lastSyncedAtBooks < getBookChangedAt(book)`
 *   permanently true (every stamp on this device sits ahead of the cursor the
 *   server stamped moments ago), so the 5-second auto-sync re-pushes the whole
 *   library forever.
 * - The device that is behind loses: a peer's position stamped by a leading
 *   clock outranks its own forever, so reading progress never converges.
 *
 * This module holds the measured gap between this device's clock and the
 * server's, and every sync-relevant stamp goes through `syncNow()` so the
 * ordering fields all speak the server's clock. Display time, stats durations
 * and local bookkeeping stay on the device clock — nothing compares them to a
 * server record.
 *
 * The gap is sampled from the `synced_at` the server writes on books rows (see
 * `SyncClient.pullChanges`), so no extra request is needed. Only a row the
 * server wrote during that same request is accepted as a sample, so the error is
 * bounded by the round trip rather than by how long the library has been quiet.
 * The estimate still lags the true server time slightly, which is the safe
 * direction: a stamp landing just behind the cursor is re-pulled once, one
 * landing ahead is what re-pushes forever.
 */

/**
 * A sample implying more skew than this is not a measurement, it is a row that
 * was written a long time ago (a quiet library pulled hours later) or a server
 * with no time source at all. Trusting it would stamp every record hours off
 * and silently freeze the sync.
 */
const MAX_TRUSTED_SKEW_MS = 10 * 60 * 1000;

let offsetMs = 0;

const applyOffset = (ms: number): boolean => {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TRUSTED_SKEW_MS) return false;
  offsetMs = ms;
  return true;
};

/** Current gap between the server clock and this device's, in ms. */
export const getSyncClockOffset = (): number => offsetMs;

/** `Date.now()` expressed in the sync server's clock. Use for ordering fields. */
export const syncNow = (): number => Date.now() + offsetMs;

/**
 * Restore a persisted offset (`settings.serverTimeOffsetMs`). Absent or
 * out-of-range values are ignored rather than zeroed: an old read of the server
 * clock beats no read at all, and zeroing would silently put a skewed device
 * back in charge of the ordering.
 */
export const setSyncClockOffset = (ms: number | null | undefined): boolean =>
  typeof ms === 'number' ? applyOffset(ms) : false;

/**
 * Record one observation of the server clock: `serverMs` is a timestamp the
 * server itself stamped, `clientMs` is this device's clock at the moment that
 * value was read off the wire. Returns false when the sample was rejected.
 */
export const observeServerClock = (serverMs: number, clientMs: number): boolean => {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return false;
  return applyOffset(serverMs - clientMs);
};
