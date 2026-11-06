import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Book, BookConfig } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';

/**
 * vitest.config.mts stubs every `foliate-js/*` subpath to an empty module, so
 * the real CFI implementation — and with it `isMalformedLocationCfi`, which is
 * built on `CFI.parse` — is a no-op here. The merge under test rejects
 * degenerate shapes with `isMalformedLocationCfi`, so this stand-in supplies
 * the guard: the empty-start (`,,`) / empty-end (`,)`) range shapes the
 * cfi-inert skip-link bug left behind.
 */
vi.mock('@/utils/cfi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/cfi')>();
  return {
    ...actual,
    isMalformedLocationCfi: (cfi: string) => /,\s*,/.test(cfi) || /,\s*\)/.test(cfi),
  };
});

const { applySyncedConfigsToLocal, mergeSyncedConfig } = await import(
  '@/services/sync/applySyncedConfigs'
);

/**
 * A library-level sync used to pull book rows only: reading progress (`configs`)
 * was pulled by the reader on book open. So a user who synced, went offline and
 * opened a book resumed at the stale local position — and the sync *inside* the
 * reader, the only thing that would fix it, needs the network that is gone.
 * These tests pin the merge that puts the pulled position on disk.
 */

const makeBook = (hash: string, overrides: Partial<Book> = {}): Book =>
  ({
    hash,
    title: `Book ${hash}`,
    author: 'Author',
    format: 'EPUB',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as Book;

const makeAppService = (locals: Record<string, BookConfig | undefined>) => {
  const saved: Record<string, BookConfig> = {};
  const appService = {
    loadBookConfig: vi.fn(
      async (book: Book) => locals[book.hash] ?? ({ updatedAt: 0, viewSettings: {} } as BookConfig),
    ),
    saveBookConfig: vi.fn(async (book: Book, config: BookConfig) => {
      saved[book.hash] = config;
    }),
  };
  return { appService, saved };
};

const apply = async (
  books: Book[],
  locals: Record<string, BookConfig | undefined>,
  configs: BookConfig[],
) => {
  useLibraryStore.getState().setLibrary(books);
  const { appService, saved } = makeAppService(locals);
  const result = await applySyncedConfigsToLocal({
    envConfig: { getAppService: async () => appService } as unknown as EnvConfigType,
    settings: {} as SystemSettings,
    configs,
  });
  return { result, saved, appService };
};

beforeEach(() => {
  useLibraryStore.setState({ library: [], hashIndex: new Map(), libraryLoaded: true });
  useReaderStore.setState({ viewStates: {} });
  // One summary line per applied pull; keep it out of the test report.
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mergeSyncedConfig', () => {
  it('adopts a newer remote position and leaves device-local config alone', () => {
    const local: BookConfig = {
      updatedAt: 100,
      location: 'epubcfi(/6/2!/4/2:0)',
      progress: [1, 100],
      booknotes: [{ id: 'n1' } as never],
      viewSettings: { zoomLevel: 200 } as never,
    };
    const remote: BookConfig = {
      updatedAt: 200,
      location: 'epubcfi(/6/40!/4/2:0)',
      progress: [42, 100],
      booknotes: [] as never,
      viewSettings: { zoomLevel: 100 } as never,
    };

    const merged = mergeSyncedConfig(local, remote);

    expect(merged?.location).toBe('epubcfi(/6/40!/4/2:0)');
    expect(merged?.progress).toEqual([42, 100]);
    expect(merged?.updatedAt).toBe(200);
    // Notes ride the separate `notes` channel; screen settings are per device.
    expect(merged?.booknotes).toEqual(local.booknotes);
    expect(merged?.viewSettings).toEqual(local.viewSettings);
  });

  it('keeps a newer local position', () => {
    const merged = mergeSyncedConfig(
      { updatedAt: 300, location: 'local' },
      { updatedAt: 200, location: 'remote' },
    );
    expect(merged).toBeNull();
  });

  it('adopts the remote position for a book this device never read', () => {
    // `deserializeConfig` stamps a config without `updatedAt` with Date.now(),
    // so an unread book looks "newer" than any remote record; an absent
    // position must still lose.
    const localAt = Date.now();
    const merged = mergeSyncedConfig(
      { updatedAt: localAt },
      { updatedAt: 200, location: 'remote-location', progress: [10, 50] },
    );
    expect(merged?.location).toBe('remote-location');
    expect(merged?.updatedAt).toBe(200);
  });

  it('keeps the local position when its clock is newer even if the remote is further', () => {
    // The deliberate trade-off of clock arbitration: "the last device the user
    // actually read on wins", so a rewind made on this device must not be
    // dragged forward by a peer's older record. The flip side is that a peer
    // whose clock lags behind this one is ignored until it reads again.
    const merged = mergeSyncedConfig(
      { updatedAt: 2000, location: 'epubcfi(/6/2!/4/2/1:0)', progress: [10, 300] },
      { updatedAt: 1000, location: 'epubcfi(/6/40!/4/2/1:0)', progress: [120, 300] },
    );
    expect(merged).toBeNull();
  });

  it('writes nothing when both clocks tie', () => {
    const merged = mergeSyncedConfig(
      { updatedAt: 1000, location: 'epubcfi(/6/40!/4/2/1:0)' },
      { updatedAt: 1000, location: 'epubcfi(/6/40!/4/2/1:0)' },
    );
    expect(merged).toBeNull();
  });

  it('adopts the remote position when its clock is newer even if it is behind', () => {
    // Clock, not distance, decides — the record that moved the reader backwards.
    const merged = mergeSyncedConfig(
      { updatedAt: 1000, location: 'epubcfi(/6/40!/4/2/1:0)' },
      { updatedAt: 2000, location: 'epubcfi(/6/2!/4/2/1:0)', progress: [10, 300] },
    );
    expect(merged?.location).toBe('epubcfi(/6/2!/4/2/1:0)');
    expect(merged?.updatedAt).toBe(2000);
  });

  it('drops a remote record with an older clock even when it carries an xpointer', () => {
    // An xpointer-only record (KOReader) carries no CFI at all: nothing about
    // its shape rescues it from the clock.
    const merged = mergeSyncedConfig(
      { updatedAt: 2000, location: 'epubcfi(/6/2!/4/2/1:0)' },
      { updatedAt: 1000, xpointer: '/body/DocFragment[9]' },
    );
    expect(merged).toBeNull();
  });

  it('adopts an xpointer-only remote when its clock is newer', () => {
    // The other half of the fallback: nothing comparable on the remote, so the
    // clock decides and the XPointer is what gets adopted.
    const merged = mergeSyncedConfig(
      { updatedAt: 1000, location: 'epubcfi(/6/2!/4/2/1:0)' },
      { updatedAt: 2000, xpointer: '/body/DocFragment[9]', progress: [90, 100] },
    );
    expect(merged?.xpointer).toBe('/body/DocFragment[9]');
    expect(merged?.progress).toEqual([90, 100]);
  });

  it('never writes a malformed local CFI back to disk', () => {
    // The local record carries the cfi-inert skip-link shape, so the sanitizer
    // rejects it — it must not survive into the merged config either, or the
    // next open resumes at page one again.
    const merged = mergeSyncedConfig(
      { updatedAt: 1000, location: 'epubcfi(/6/24!/4,,/20/1:58)' },
      { updatedAt: 2000, xpointer: '/body/DocFragment[9]', progress: [90, 100] },
    );
    expect(merged?.location).toBeUndefined();
  });

  it('drops a stale local XPointer when the remote has a location but no XPointer', () => {
    const merged = mergeSyncedConfig(
      { updatedAt: 100, location: 'local-cfi', xpointer: '/body/DocFragment[3]' },
      { updatedAt: 200, location: 'remote-cfi' },
    );
    expect(merged?.xpointer).toBe('');
  });

  it('ignores a remote record that carries no position at all', () => {
    expect(
      mergeSyncedConfig(
        { updatedAt: 100, location: 'local' },
        { updatedAt: 200, progress: [5, 10] },
      ),
    ).toBeNull();
  });

  it('never persists a malformed synced CFI', () => {
    // An empty-start range CFI left in the cloud by the cfi-inert skip-link bug.
    // The reader discards these before applying them (#5859); writing one to
    // config.json is what makes the next open resume at page one.
    expect(
      mergeSyncedConfig(
        { updatedAt: 100, location: 'epubcfi(/6/2!/4/2:0)' },
        { updatedAt: 200, location: 'epubcfi(/6/24!/4,,/20/1:58)' },
      ),
    ).toBeNull();
  });
});

describe('applySyncedConfigsToLocal', () => {
  it('writes the synced position to each book config on disk', async () => {
    const { result, saved, appService } = await apply(
      [makeBook('b1'), makeBook('b2')],
      {
        b1: { updatedAt: 100, location: 'old-b1', progress: [1, 10] },
        b2: { updatedAt: 500, location: 'newer-b2', progress: [9, 10] },
      },
      [
        { bookHash: 'b1', updatedAt: 200, location: 'synced-b1', progress: [7, 10] },
        { bookHash: 'b2', updatedAt: 400, location: 'stale-b2', progress: [2, 10] },
      ],
    );

    expect(result.applied).toBe(1);
    expect(result.pending.size).toBe(0);
    expect(saved['b1']).toMatchObject({ location: 'synced-b1', progress: [7, 10], updatedAt: 200 });
    expect(saved['b2']).toBeUndefined();
    expect(appService.loadBookConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest record when a pull replays a book hash', async () => {
    const { result, saved } = await apply(
      [makeBook('b1')],
      { b1: { updatedAt: 100, location: 'old' } },
      [
        { bookHash: 'b1', updatedAt: 200, location: 'synced' },
        { bookHash: 'b1', updatedAt: 150, location: 'older-replay' },
      ],
    );

    expect(result.applied).toBe(1);
    expect(saved['b1']?.location).toBe('synced');
  });

  it('reports configs whose book is not in the library yet as pending', async () => {
    const { result, appService } = await apply(
      [makeBook('b1')],
      { b1: { updatedAt: 100, location: 'old' } },
      [
        { bookHash: 'b1', updatedAt: 200, location: 'synced' },
        // Book row arrives from the books pull a moment later.
        { bookHash: 'b2', updatedAt: 200, location: 'synced-b2' },
      ],
    );

    expect(result.applied).toBe(1);
    expect([...result.pending]).toEqual(['b2']);
    expect(appService.saveBookConfig).toHaveBeenCalledTimes(1);
  });

  it('never writes a deleted book or one that is open in a view', async () => {
    useReaderStore.setState({ viewStates: { 'b3-view1': {} as never } });

    const { result, saved, appService } = await apply(
      [makeBook('b1', { deletedAt: 10 }), makeBook('b3')],
      { b1: { updatedAt: 100, location: 'old' }, b3: { updatedAt: 100, location: 'old' } },
      [
        { bookHash: 'b1', updatedAt: 200, location: 'synced' },
        { bookHash: 'b3', updatedAt: 200, location: 'synced' },
      ],
    );

    expect(result.applied).toBe(0);
    expect(saved).toEqual({});
    expect(appService.loadBookConfig).not.toHaveBeenCalled();
  });
});
