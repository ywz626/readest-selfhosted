import { create } from 'zustand';
import { SystemSettings } from '@/types/settings';
import { Book, BookConfig, BookFormat, BookNote } from '@/types/book';
import { EnvConfigType } from '@/services/environment';
import { BookDoc } from '@/libs/document';
import { syncNow } from '@/services/sync/clock';
import { useLibraryStore } from './libraryStore';

// Throttle library.json writes triggered by per-book saveConfig.
//
// Why: `saveConfig` ran two large fs.writeFile IPC calls *every* invocation —
// one for the per-book config.json and one for the WHOLE library.json (because
// saveLibraryBooks writes a backup + the file itself). For a user with N
// books in their shelf, that's `2 * JSON.stringify(N entries)` of work + 2
// Tauri IPC round-trips per save. With auto-save firing once per second of
// reading (useProgressAutoSave), Chrome DevTools' Bottom-Up profile shows
// `processIpcMessage` chewing ~25% of main-thread time during a reading
// session — directly responsible for the swipe jank the user is reporting
// (touchmove gets queued behind IPC processing).
//
// The library array itself is updated immutably via setLibrary on every save
// (see `setLibrary(newLibrary)` below) so in-memory state and zustand
// subscribers see the change immediately. Disk persistence can be deferred:
// progress is also stored in each book's own config.json (which we still
// write every time), so even if the app dies between throttle ticks the
// shelf will reconstruct correct progress from those per-book files on
// next launch.
//
// LIBRARY_SAVE_THROTTLE_MS=30s: long enough to collapse a swipe burst into a
// single IPC, short enough that a user who closes the book within half a
// minute still sees the shelf update without a follow-up flush. Force-flush
// happens via flushPendingLibrarySave() on hook unmount + window blur.
const LIBRARY_SAVE_THROTTLE_MS = 30_000;
let librarySaveTimeoutId: ReturnType<typeof setTimeout> | null = null;
let librarySaveAppService: { saveLibraryBooks: (books: Book[]) => Promise<void> } | null = null;
const scheduleLibrarySave = (appService: {
  saveLibraryBooks: (books: Book[]) => Promise<void>;
}) => {
  librarySaveAppService = appService;
  if (librarySaveTimeoutId != null) return;
  librarySaveTimeoutId = setTimeout(() => {
    librarySaveTimeoutId = null;
    const svc = librarySaveAppService;
    if (!svc) return;
    const { library } = useLibraryStore.getState();
    svc.saveLibraryBooks(library).catch((err) => {
      console.warn('Throttled library save failed:', err);
    });
  }, LIBRARY_SAVE_THROTTLE_MS);
};
export const flushPendingLibrarySave = async () => {
  if (librarySaveTimeoutId == null || !librarySaveAppService) return;
  clearTimeout(librarySaveTimeoutId);
  librarySaveTimeoutId = null;
  const { library } = useLibraryStore.getState();
  await librarySaveAppService.saveLibraryBooks(library);
};

export interface BookData {
  /* Persistent data shared with different views of the same book */
  id: string;
  book: Book | null;
  file: File | null;
  config: BookConfig | null;
  bookDoc: BookDoc | null;
  /* Format the document parsed as; differs from book.format for streamed stubs */
  docFormat?: BookFormat;
  isFixedLayout: boolean;
}

interface BookDataState {
  booksData: { [id: string]: BookData };
  getConfig: (key: string | null) => BookConfig | null;
  setConfig: (key: string, partialConfig: Partial<BookConfig>) => void;
  saveConfig: (
    envConfig: EnvConfigType,
    bookKey: string,
    config: BookConfig,
    settings: SystemSettings,
  ) => Promise<void>;
  updateBooknotes: (key: string, booknotes: BookNote[]) => BookConfig | undefined;
  getBookData: (keyOrId: string) => BookData | null;
  clearBookData: (keyOrId: string) => void;
}

/**
 * Drop booknotes that carry no CFI. Such a note has no anchor in the book: it
 * can't be rendered, navigated to, or ordered against anything. Worse, it is
 * actively dangerous — `CFI.compare` dereferences both of its arguments, so a
 * null/undefined cfi reaching a sort comparator or `findNearestCfi` throws
 * during render and drops the whole app to the error boundary.
 *
 * `BookNote.cfi` is typed `string`, but that isn't enforced at runtime for data
 * we didn't create: file sync (`services/sync/file/wire.ts`), backup restore,
 * and the Foliate importer all parse foreign JSON straight into booknotes.
 * Every write to `config.booknotes` funnels through this store, so discard them
 * here rather than defending each of the many CFI comparison sites.
 */
const discardUnanchoredBooknotes = (booknotes: BookNote[]): BookNote[] =>
  booknotes.filter((booknote) => booknote.cfi);

export const useBookDataStore = create<BookDataState>((set, get) => ({
  booksData: {},
  getBookData: (keyOrId: string) => {
    const id = keyOrId.split('-')[0]!;
    return get().booksData[id] || null;
  },
  clearBookData: (keyOrId: string) => {
    const id = keyOrId.split('-')[0]!;
    set((state) => {
      const newBooksData = { ...state.booksData };
      delete newBooksData[id];
      return {
        booksData: newBooksData,
      };
    });
  },
  getConfig: (key: string | null) => {
    if (!key) return null;
    const id = key.split('-')[0]!;
    return get().booksData[id]?.config || null;
  },
  setConfig: (key: string, partialConfig: Partial<BookConfig>) => {
    set((state: BookDataState) => {
      const id = key.split('-')[0]!;
      const config = state.booksData[id]?.config;
      if (!config) {
        console.warn('No config found for book', id);
        return state;
      }
      const update = partialConfig.booknotes
        ? { ...partialConfig, booknotes: discardUnanchoredBooknotes(partialConfig.booknotes) }
        : partialConfig;
      return {
        booksData: {
          ...state.booksData,
          [id]: {
            ...state.booksData[id]!,
            config: { ...config, ...update },
          },
        },
      };
    });
  },
  saveConfig: async (
    envConfig: EnvConfigType,
    bookKey: string,
    config: BookConfig,
    settings: SystemSettings,
  ) => {
    const appService = await envConfig.getAppService();
    const { library, hashIndex, setLibrary } = useLibraryStore.getState();
    const hash = bookKey.split('-')[0]!;
    const idx = hashIndex.get(hash);
    if (idx === undefined) return;

    // Immutably move the book to the front of the library with updated
    // progress and timestamps. We do NOT mutate the existing book object or
    // the existing library array — Zustand subscribers see fresh references
    // and the visibleLibrary cache stays in sync via setLibrary's full update.
    const now = syncNow();
    const original = library[idx]!;
    // Same rule as `updateBookProgress`: the row's `updatedAt` is the clock
    // `progress` is merged on, so a save that did not turn a page must not
    // advance it. Opening and closing a book both land here, and each no-op
    // save used to re-publish this device's stale percentage as the newest row
    // — which is what dragged the shelf back after another device had read.
    const pageMoved = (original.progress?.[0] ?? 0) !== (config.progress?.[0] ?? 0);
    // An annotation / bookmark edit leaves `updatedAt` alone (that is the
    // progress clock above) but peers still have to learn the notes changed, so
    // it travels on its own row clock. `Math.max` for the same reason as the
    // config clock below: a stale config handed in by a caller must never lower
    // a clock this device already published.
    const notesUpdatedAt =
      Math.max(original.notesUpdatedAt ?? 0, config.notesUpdatedAt ?? 0) || undefined;
    const updatedBook: Book = {
      ...original,
      progress: config.progress,
      updatedAt: pageMoved ? now : (original.updatedAt ?? now),
      // Device-local bookkeeping — nothing ever compares it to a server record,
      // so it stays on the wall clock (`syncNow()` would put it in the future
      // whenever this device lags the server).
      downloadedAt: original.downloadedAt || Date.now(),
      // Only set when there is a clock to carry: an explicit `undefined` key on
      // every row would churn library.json for nothing.
      ...(notesUpdatedAt ? { notesUpdatedAt } : {}),
    };
    const newLibrary = [updatedBook, ...library.slice(0, idx), ...library.slice(idx + 1)];
    setLibrary(newLibrary);

    // Refresh the store config immutably rather than mutating the
    // caller-provided object. This notifies Zustand subscribers and works
    // regardless of whether the caller passed the shared store config.
    //
    // The config's `updatedAt` is NOT that refreshed timestamp: it is the
    // cross-device progress clock, and the server plus every peer keep the
    // record carrying the highest one (`configs` LWW, and the piggyback that
    // copies progress onto the book row). Stamping it here on every save made
    // mere book opens, closes and annotation edits outrank the device the user
    // actually read on — this save then re-published a stale position as the
    // newest record, the peer's newer position was rejected as "not newer",
    // and its push lost to the next no-op save. Only `setProgress` (a page
    // actually turned) and callers that explicitly pass a bumped stamp may
    // advance this clock; everything else carries the existing value forward.
    const configUpdatedAt =
      Math.max(get().getConfig(bookKey)?.updatedAt ?? 0, config.updatedAt ?? 0) || now;
    const configNotesUpdatedAt =
      Math.max(get().getConfig(bookKey)?.notesUpdatedAt ?? 0, config.notesUpdatedAt ?? 0) ||
      undefined;
    get().setConfig(bookKey, {
      updatedAt: configUpdatedAt,
      ...(configNotesUpdatedAt ? { notesUpdatedAt: configNotesUpdatedAt } : {}),
    });
    const configToSave = {
      ...config,
      updatedAt: configUpdatedAt,
      ...(configNotesUpdatedAt ? { notesUpdatedAt: configNotesUpdatedAt } : {}),
    };
    // Per-book config: still write eagerly — it's small (one book's
    // settings + booknotes) and is the source of truth used by sync to
    // reconstruct the shelf if library.json is missing or stale.
    await appService.saveBookConfig(updatedBook, configToSave, settings);
    // Library JSON write: throttled (see scheduleLibrarySave docs) so a
    // burst of saveConfig calls during reading doesn't fire IPC on every
    // page turn.
    scheduleLibrarySave(appService);
  },
  updateBooknotes: (key: string, booknotes: BookNote[]) => {
    let updatedConfig: BookConfig | undefined;
    set((state) => {
      const id = key.split('-')[0]!;
      const book = state.booksData[id];
      if (!book) return state;
      const dedupedBooknotes = Array.from(
        new Map(
          discardUnanchoredBooknotes(booknotes).map((item) => [
            `${item.id}-${item.type}-${item.cfi}`,
            item,
          ]),
        ).values(),
      );
      // `updatedAt` is the cross-device PROGRESS clock: `mergeSyncedConfig` and
      // the cloud config LWW compare it, so stamping it on an annotation edit
      // re-published whatever position this config held as the newest record,
      // and the peer's later position lost to it. The notes themselves travel
      // on the `notes` channel with their own per-note stamps; file sync needs
      // only a per-row hint that the config changed, which is `notesUpdatedAt`
      // (`saveConfig` lifts it onto the library row). Monotonic like the
      // progress clock, for the same future-stamp reason.
      const now = Math.max(syncNow(), (book.config?.notesUpdatedAt ?? 0) + 1);
      // `updatedAt` is carried forward untouched — the `?? now` only fills in a
      // config that was loaded without any clock at all, which is the same
      // fallback `deserializeConfig` applies.
      const carriedUpdatedAt = book.config?.updatedAt ?? now;
      updatedConfig = {
        ...book.config,
        updatedAt: carriedUpdatedAt,
        notesUpdatedAt: now,
        booknotes: dedupedBooknotes,
      };
      return {
        booksData: {
          ...state.booksData,
          [id]: {
            ...book,
            config: {
              ...book.config,
              updatedAt: carriedUpdatedAt,
              notesUpdatedAt: now,
              booknotes: dedupedBooknotes,
            },
          },
        },
      };
    });
    return updatedConfig;
  },
}));
