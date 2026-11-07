import { describe, expect, test } from 'vitest';
import {
  buildRemotePayload,
  parseRemotePayload,
  parseRemoteLibraryIndex,
  stripDeviceLocalFields,
} from '@/services/sync/file/wire';
import type { Book, BookConfig } from '@/types/book';

const book = {
  hash: 'h1',
  metaHash: 'm1',
  format: 'EPUB',
  title: 'T',
  author: 'A',
  createdAt: 1,
  updatedAt: 1,
} as Book;

// Cast through unknown so a device-local field (viewSettings) can be present
// on the source config without fighting the BookConfig type — the point of
// the test is that it never reaches the wire.
const config = {
  updatedAt: 42,
  progress: [3, 10],
  location: 'loc',
  xpointer: 'xp',
  booknotes: [],
  viewSettings: { fontSize: 14 },
} as unknown as BookConfig;

describe('wire envelope (frozen)', () => {
  test('buildRemotePayload trims to reading state + stable header', () => {
    const p = buildRemotePayload(book, config, 'dev-1');
    expect(p.schemaVersion).toBe(1);
    expect(p.writerVersion).toBe('readest-webdav-1');
    expect(p.writerDeviceId).toBe('dev-1');
    expect(p.bookHash).toBe('h1');
    expect(p.metaHash).toBe('m1');
    expect(p.config).toEqual({ progress: [3, 10], location: 'loc', xpointer: 'xp', updatedAt: 42 });
    // Device-local fields never travel.
    expect('viewSettings' in p.config).toBe(false);
  });

  test('preserves a reserved Notebook record through the frozen wire envelope', () => {
    const notebookConfig: BookConfig = {
      ...config,
      booknotes: [
        {
          id: 'notebook',
          type: 'notebook',
          cfi: 'epubcfi(/6/2)',
          note: '# Notes',
          createdAt: 10,
          updatedAt: 20,
        },
      ],
    };

    const parsed = parseRemotePayload(
      JSON.stringify(buildRemotePayload(book, notebookConfig, 'dev-1')),
    );

    expect(parsed?.booknotes).toEqual(notebookConfig.booknotes);
  });

  // Issue #5716. The count stands in for the book's own page list, so it is
  // book data rather than a screen preference. It rides its own envelope key
  // instead of `config.viewSettings` so the generic scalar spread in
  // mergeBookConfig can never replace a peer's whole viewSettings object.
  test('buildRemotePayload carries the reference page count outside config', () => {
    const withCount = {
      ...config,
      viewSettings: { fontSize: 14, referencePageCount: 350 },
    } as unknown as BookConfig;
    const p = buildRemotePayload(book, withCount, 'dev-1');
    expect(p.referencePageCount).toBe(350);
    // Still never leaks the rest of viewSettings.
    expect('viewSettings' in p.config).toBe(false);
  });

  test('buildRemotePayload omits the count when the user never set one', () => {
    const p = buildRemotePayload(book, config, 'dev-1');
    expect(p.referencePageCount).toBeUndefined();
  });

  test('parseRemotePayload rejects null / non-JSON / wrong schema', () => {
    expect(parseRemotePayload(null)).toBeNull();
    expect(parseRemotePayload('not json')).toBeNull();
    expect(parseRemotePayload(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
    const ok = parseRemotePayload(JSON.stringify(buildRemotePayload(book, config, 'd')));
    expect(ok?.bookHash).toBe('h1');
  });

  test('parseRemoteLibraryIndex rejects null / malformed / wrong schema', () => {
    expect(parseRemoteLibraryIndex(null)).toBeNull();
    expect(parseRemoteLibraryIndex('{')).toBeNull();
    expect(parseRemoteLibraryIndex(JSON.stringify({ schemaVersion: 9, books: [] }))).toBeNull();
    const ok = parseRemoteLibraryIndex(
      JSON.stringify({ schemaVersion: 1, books: [book], updatedAt: 5 }),
    );
    expect(ok?.books).toHaveLength(1);
    expect(ok?.updatedAt).toBe(5);
  });

  test('parseRemoteLibraryIndex preserves the optional uploadedHashes record (#4856)', () => {
    const parsed = parseRemoteLibraryIndex(
      JSON.stringify({ schemaVersion: 1, books: [book], updatedAt: 5, uploadedHashes: ['h1'] }),
    );
    expect(parsed?.uploadedHashes).toEqual(['h1']);
    // Legacy index without the field parses fine (treated as empty by the engine).
    const legacy = parseRemoteLibraryIndex(
      JSON.stringify({ schemaVersion: 1, books: [book], updatedAt: 5 }),
    );
    expect(legacy?.uploadedHashes).toBeUndefined();
  });

  // An offline Audiobookshelf download lives on this device only (#6256).
  test('stripDeviceLocalFields drops the offline-download stamp', () => {
    const stripped = stripDeviceLocalFields({ ...book, format: 'ABS', absDownloadedAt: 7 });
    expect(stripped).not.toHaveProperty('absDownloadedAt');
  });
});

describe('remote clock validation', () => {
  const bogus = {
    notesUpdatedAt: Number.MAX_VALUE,
    metadataUpdatedAt: 'not-a-number',
    groupUpdatedAt: -1,
    readingStatusUpdatedAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    deletedAt: 8.7e15, // beyond JS Date's range: toISOString() would throw
  };

  test('drops implausible clocks from a shared library.json row', () => {
    const parsed = parseRemoteLibraryIndex(
      JSON.stringify({ schemaVersion: 1, books: [{ ...book, ...bogus }], updatedAt: 5 }),
    );
    const row = parsed!.books[0]!;
    expect(row.notesUpdatedAt).toBeUndefined();
    expect(row.metadataUpdatedAt).toBeUndefined();
    expect(row.groupUpdatedAt).toBeUndefined();
    expect(row.readingStatusUpdatedAt).toBeUndefined();
    expect(row.deletedAt).toBeUndefined();
    // Plausible stamps survive untouched.
    expect(row.createdAt).toBe(1);
    expect(row.updatedAt).toBe(1);
    expect(parsed!.updatedAt).toBe(5);
  });

  test('normalizes an implausible required row clock to 0', () => {
    const parsed = parseRemoteLibraryIndex(
      JSON.stringify({
        schemaVersion: 1,
        books: [{ ...book, updatedAt: Number.MAX_VALUE }],
        updatedAt: Number.MAX_VALUE,
      }),
    );
    expect(parsed!.books[0]!.updatedAt).toBe(0);
    expect(parsed!.updatedAt).toBe(0);
  });

  test('rejects an index whose books is not an array', () => {
    expect(
      parseRemoteLibraryIndex(JSON.stringify({ schemaVersion: 1, books: {}, updatedAt: 5 })),
    ).toBeNull();
  });

  test('drops implausible clocks from a per-book config.json envelope', () => {
    const raw = JSON.parse(JSON.stringify(buildRemotePayload(book, config, 'dev-1'))) as Record<
      string,
      unknown
    >;
    (raw['config'] as Record<string, unknown>)['notesUpdatedAt'] = Number.MAX_VALUE;
    raw['booknotes'] = [{ id: 'n1', type: 'bookmark', updatedAt: Number.MAX_VALUE, createdAt: 1 }];
    raw['updatedAt'] = Number.MAX_VALUE;

    const parsed = parseRemotePayload(JSON.stringify(raw));
    expect(parsed!.updatedAt).toBe(0);
    expect(parsed!.config.notesUpdatedAt).toBeUndefined();
    expect(parsed!.booknotes[0]!.updatedAt).toBe(0);
    expect(parsed!.booknotes[0]!.createdAt).toBe(1);
  });
});
