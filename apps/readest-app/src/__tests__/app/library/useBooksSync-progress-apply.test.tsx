import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import type { Book, BookConfig, BookDataRecord } from '@/types/book';
import type { SystemSettings } from '@/types/settings';

/**
 * End-to-end repro of the reported bug, on the REAL chain:
 *
 *   SettingsMenu "Sync" → pullLibrary → syncBooks('pull')
 *     → pullProgress() → SyncClient.pullChanges('configs')
 *     → useSync [syncResult] effect → syncedConfigs
 *     → useBooksSync [syncedConfigs] effect → applySyncedConfigsToLocal
 *     → appService.saveBookConfig(config.json)
 *
 * Only the transport (SyncClient), the platform service and the auth/translation
 * contexts are mocked. Everything else is the production code the user runs.
 *
 * The position-ordering of the MERGE itself (CFI.compare, furthest wins) is
 * unit-tested in applySyncedConfigs.test.ts with a CFI stand-in — this file
 * exists to prove the full pipeline lands a pulled config on disk, which a
 * broken effect/state hand-off would not show.
 */

const FAR = 'epubcfi(/6/40!/4/2/1:0)';

const harness = vi.hoisted(() => {
  const savedConfigs: Record<string, BookConfig> = {};
  return {
    savedConfigs,
    appService: {
      saveSettings: vi.fn(async () => {}),
      saveLibraryBooks: vi.fn(async () => {}),
      generateCoverImageUrl: vi.fn(async () => 'blob:cover'),
      downloadBookCovers: vi.fn(async () => {}),
      loadBookConfig: vi.fn(async () => ({ updatedAt: 0 }) as BookConfig),
      saveBookConfig: vi.fn(async (book: Book, config: BookConfig) => {
        savedConfigs[book.hash] = config;
      }),
    },
    // The remote row in DB shape — pullChanges returns raw records that
    // transformBookConfigFromDB parses, exactly like the server does.
    pullChanges: vi.fn(async (_since: number, type: string) => {
      if (type === 'configs') {
        return {
          configs: [
            {
              book_hash: 'h1',
              meta_hash: 'm1',
              location: FAR,
              progress: JSON.stringify([120, 300]),
              updated_at: Date.now(),
            },
          ] as unknown as BookDataRecord[],
        };
      }
      return { books: [] };
    }),
  };
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: { pullChanges: harness.pullChanges } }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: async () => harness.appService },
    appService: harness.appService,
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));

vi.mock('@/services/sync/file/runLibrarySync', () => ({
  runFileLibrarySyncPass: vi.fn(async () => null),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (text: string) => text,
}));

const { useBooksSync } = await import('@/app/library/hooks/useBooksSync');
const { useLibraryStore } = await import('@/store/libraryStore');
const { useSettingsStore } = await import('@/store/settingsStore');
const { useReaderStore } = await import('@/store/readerStore');
const { eventDispatcher } = await import('@/utils/event');

beforeEach(() => {
  vi.clearAllMocks();
  useReaderStore.setState({ viewStates: {} });
  useLibraryStore.setState({
    library: [],
    hashIndex: new Map(),
    libraryLoaded: true,
    isSyncing: false,
  });
  useLibraryStore.getState().setLibrary([
    {
      hash: 'h1',
      title: 'Book',
      author: 'A',
      format: 'EPUB',
      createdAt: 1,
      updatedAt: 1,
    } as Book,
  ]);
  useSettingsStore.setState({
    settings: {
      version: 1,
      keepLogin: true,
      lastSyncedAtBooks: 0,
      lastSyncedAtConfigs: 0,
      lastSyncedAtNotes: 0,
    } as SystemSettings,
  });
  for (const key of Object.keys(harness.savedConfigs)) delete harness.savedConfigs[key];
});

describe('library sync lands reading progress for an offline resume', () => {
  it('writes the synced position to config.json on a library sync', async () => {
    renderHook(() => useBooksSync());

    await waitFor(
      () => {
        expect(harness.savedConfigs['h1']).toBeTruthy();
      },
      { timeout: 4000 },
    );

    expect(harness.savedConfigs['h1']!.location).toBe(FAR);
    expect(harness.savedConfigs['h1']!.progress).toEqual([120, 300]);
  });

  it('pulls the configs channel again on an explicit manual sync', async () => {
    const { result } = renderHook(() => useBooksSync());

    await waitFor(() => expect(harness.pullChanges).toHaveBeenCalled(), { timeout: 4000 });
    harness.pullChanges.mockClear();

    // The mount pull may still hold the shared isPullingRef; settle it first.
    await waitFor(() => expect(result.current).toBeTruthy());
    await result.current.pullLibrary(false, true);

    await waitFor(
      () => {
        expect(harness.pullChanges).toHaveBeenCalledWith(
          expect.any(Number),
          'configs',
          undefined,
          undefined,
        );
      },
      { timeout: 4000 },
    );
  });

  it('toasts that reading progress synced after a manual sync applies it', async () => {
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    const { result } = renderHook(() => useBooksSync());

    await waitFor(() => expect(harness.pullChanges).toHaveBeenCalled(), { timeout: 4000 });
    dispatchSpy.mockClear();

    await waitFor(() => expect(result.current).toBeTruthy());
    await result.current.pullLibrary(false, true);

    await waitFor(
      () => {
        const toasts = dispatchSpy.mock.calls.filter(([event]) => event === 'toast');
        // The manual sync toasts the book count first, then the progress toast
        // (the apply runs in the effect after the pull resolves).
        expect(
          toasts.some(
            ([, payload]) =>
              (payload as { message?: string }).message === 'Reading Progress Synced',
          ),
        ).toBe(true);
      },
      { timeout: 4000 },
    );
  });

  afterEach(() => cleanup());
});
