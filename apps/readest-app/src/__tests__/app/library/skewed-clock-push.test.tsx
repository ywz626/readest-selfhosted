import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { Book } from '@/types/book';

/**
 * The library auto-sync asks "did any clock on this row move past the cursor
 * the server stamped?" — and the cursor is the SERVER's clock while the answer
 * is computed from stamps THIS device's clock wrote. On a machine running a few
 * seconds ahead the answer is yes forever, so every 5-second tick re-pushes the
 * whole library. Sync-relevant stamps go through the measured server clock
 * (`services/sync/clock`), which makes the same comparison converge.
 */

const SERVER_LAGS_US = 4_300;
// The device reads this where the server reads 96_000.
const DEVICE_NOW = 100_000;
const SERVER_NOW = DEVICE_NOW - SERVER_LAGS_US;

const appService = vi.hoisted(() => ({
  saveLibraryBooks: vi.fn(async () => {}),
  generateCoverImageUrl: vi.fn(async () => 'blob:cover'),
  downloadBookCovers: vi.fn(async () => {}),
}));

const syncState = vi.hoisted(() => ({
  useSyncInited: true,
  syncedBooks: null as Book[] | null,
  syncBooks: vi.fn(async (_books?: Book[], _op?: string, _since?: number) => 0),
  syncedConfigs: null as unknown[] | null,
  syncConfigs: vi.fn(async (..._args: unknown[]) => {}),
  lastSyncedAtBooks: 96_000,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService }),
}));

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: {} }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (text: string) => text,
}));

vi.mock('@/hooks/useSync', () => ({
  useSync: () => syncState,
}));

vi.mock('@/services/sync/cloudSyncProvider', () => ({
  isReadestCloudEnabled: () => true,
  getActiveFileSyncBackends: () => [],
}));

vi.mock('@/services/sync/file/runLibrarySync', () => ({
  runFileLibrarySyncPass: vi.fn(async () => ({ booksSynced: 0 })),
}));

const { useBooksSync } = await import('@/app/library/hooks/useBooksSync');
const { useLibraryStore } = await import('@/store/libraryStore');
const { setSyncClockOffset } = await import('@/services/sync/clock');

const makeBook = (over: Partial<Book> & Pick<Book, 'hash'>): Book => ({
  format: 'EPUB',
  title: 'Title',
  author: 'Author',
  createdAt: 1000,
  updatedAt: 90_000,
  syncedAt: 90_000,
  ...over,
});

const pushedHashes = () =>
  new Set(
    syncState.syncBooks.mock.calls
      .flatMap((call) => (call[0] ?? []) as Book[])
      .map((book) => book.hash),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(DEVICE_NOW);
  syncState.syncedBooks = null;
  setSyncClockOffset(-SERVER_LAGS_US);
  useLibraryStore.setState({ library: [], libraryLoaded: true, isSyncing: false });
});

afterEach(() => {
  setSyncClockOffset(0);
  vi.restoreAllMocks();
});

describe('a device clock leading the sync server', () => {
  it('does not re-push a book the page turn just stamped', async () => {
    syncState.lastSyncedAtBooks = 96_000;
    useLibraryStore.getState().setLibrary([makeBook({ hash: 'b1' })]);

    const { result } = renderHook(() => useBooksSync());
    // A page turn: the row clock is written on the server's clock, so it stays
    // behind the cursor the server is about to stamp.
    useLibraryStore.getState().updateBookProgress('b1', [5, 100], 'reading');
    await result.current.pushLibrary();

    expect(useLibraryStore.getState().library[0]!.updatedAt).toBe(SERVER_NOW);
    expect([...pushedHashes()]).toEqual([]);
  });

  it('still pushes it while the server cursor has not caught up', async () => {
    // The stamp the page turn is about to write is ahead of this cursor.
    syncState.lastSyncedAtBooks = SERVER_NOW - 1_000;
    useLibraryStore.getState().setLibrary([makeBook({ hash: 'b1' })]);

    const { result } = renderHook(() => useBooksSync());
    useLibraryStore.getState().updateBookProgress('b1', [5, 100], 'reading');
    await result.current.pushLibrary();

    expect([...pushedHashes()]).toEqual(['b1']);
  });
});
