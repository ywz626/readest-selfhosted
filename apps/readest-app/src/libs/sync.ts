import { Book, BookConfig, BookNote, BookDataRecord } from '@/types/book';
import { getAPIBaseUrl } from '@/services/environment';
import { getAccessToken } from '@/utils/access';
import { fetchWithTimeout } from '@/utils/fetch';
import { observeServerClock, syncNow } from '@/services/sync/clock';

const SYNC_API_ENDPOINT = getAPIBaseUrl() + '/sync';

export type SyncType = 'books' | 'configs' | 'notes' | 'stats';
export type SyncOp = 'push' | 'pull' | 'both';

interface BookRecord extends BookDataRecord, Book {}
interface BookConfigRecord extends BookDataRecord, BookConfig {}
interface BookNoteRecord extends BookDataRecord, BookNote {}

export interface StatBookRecord {
  user_id?: string;
  book_hash: string;
  title: string;
  authors: string;
  updated_at?: string;
  updated_at_ms?: number; // epoch ms, attached by the GET response for cursor math
  deleted_at?: string | null;
}

export interface StatPageRecord {
  user_id?: string;
  book_hash: string;
  page: number;
  start_time: number;
  duration: number;
  total_pages: number;
  ext?: unknown;
  updated_at?: string;
  updated_at_ms?: number; // epoch ms, attached by the GET response for cursor math
  deleted_at?: string | null;
}

export interface SyncResult {
  books: BookRecord[] | null;
  notes: BookNoteRecord[] | null;
  configs: BookConfigRecord[] | null;
  statBooks?: StatBookRecord[] | null;
  statPages?: StatPageRecord[] | null;
  /** Server clock (epoch ms) as this pull response was built. Absent on older backends. */
  serverTimeMs?: number;
}

export type SyncRecord = BookRecord & BookConfigRecord & BookNoteRecord;

/**
 * How fresh a `synced_at` must be to count as a reading of the server clock. A
 * delta pull returns every row the server wrote since the cursor, including ones
 * written hours ago; taken as a sample, one of those would say "the server is
 * minutes behind us" — this device would lose each merge and its own fresh
 * changes would sit below the push cursor. Only a row written during this
 * request bounds the error by the round trip.
 */
const MAX_SAMPLE_AGE_MS = 5_000;

/**
 * Two ways to read the server clock, in order of trust:
 *
 * 1. `serverTimeMs`, stamped by the server while it built THIS response. It is
 *    a direct reading, so neither the device's (skewed) clock nor the age of
 *    rows in a delta pull plays any part. This is what bootstraps a device
 *    whose clock leads the server by more than MAX_SAMPLE_AGE_MS: with only
 *    `synced_at` to go on, "device is 30s fast" and "row is 30s old" are
 *    indistinguishable, and the first sample can never be taken.
 * 2. Legacy backends: the newest `synced_at` among the pulled books rows. Its
 *    age MUST be measured on the corrected clock (`syncNow()`), not `Date.now()`:
 *    `Date.now() - synced_at` mixes two clocks and equals
 *    `(device - server) + rowAge`, which shrinks the window to zero for a
 *    leading device and lets a lagging device accept rows written minutes ago.
 *    Configs/notes carry no server stamp, and an empty pull says nothing —
 *    then the last known offset stays in force.
 */
const noteServerClock = (result: SyncResult, clientNow: number) => {
  if (typeof result.serverTimeMs === 'number' && Number.isFinite(result.serverTimeMs)) {
    observeServerClock(result.serverTimeMs, clientNow);
    return;
  }

  let freshest = 0;
  for (const record of result.books ?? []) {
    const syncedAt = record.synced_at ? new Date(record.synced_at).getTime() : 0;
    if (syncedAt > freshest) freshest = syncedAt;
  }
  if (!freshest) return;
  const age = syncNow() - freshest;
  if (age >= 0 && age <= MAX_SAMPLE_AGE_MS) {
    observeServerClock(freshest, clientNow);
  }
};

export interface SyncData {
  books?: Partial<BookRecord>[];
  notes?: Partial<BookNoteRecord>[];
  configs?: Partial<BookConfigRecord>[];
  statBooks?: StatBookRecord[];
  statPages?: StatPageRecord[];
}

export class SyncClient {
  /**
   * Pull incremental changes since a given timestamp (in ms).
   * Returns updated or deleted records since that time.
   */
  async pullChanges(
    since: number,
    type?: SyncType,
    book?: string,
    metaHash?: string,
    limit?: number,
  ): Promise<SyncResult> {
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');

    const limitParam = limit && limit > 0 ? `&limit=${encodeURIComponent(limit)}` : '';
    const url = `${SYNC_API_ENDPOINT}?since=${encodeURIComponent(since)}&type=${type ?? ''}&book=${book ?? ''}&meta_hash=${metaHash ?? ''}${limitParam}`;
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      15000,
    );

    if (!res.ok) {
      const error = await res.json();
      throw new Error(`Failed to pull changes: ${error.error || res.statusText}`);
    }

    const result = (await res.json()) as SyncResult;
    noteServerClock(result, Date.now());
    return result;
  }

  /**
   * Push local changes to the server.
   * Uses last-writer-wins logic as implemented on the server side.
   */
  async pushChanges(payload: SyncData): Promise<SyncResult> {
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');

    const res = await fetchWithTimeout(
      SYNC_API_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      },
      15000,
    );

    if (!res.ok) {
      const error = await res.json();
      throw new Error(`Failed to push changes: ${error.error || res.statusText}`);
    }

    return res.json();
  }
}
