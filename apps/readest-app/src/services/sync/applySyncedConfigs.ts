import type { BookConfig } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';
import { isMalformedLocationCfi } from '@/utils/cfi';

/**
 * Library-level convergence of the reading-progress channel.
 *
 * Reading progress travels on its OWN channel (`configs`), separate from the
 * `books` rows the library sync pulls. Until this module existed, configs were
 * only ever pulled from the reader, on book open (useProgressSync) — so a
 * library-level sync ("Sync now" / auto sync) moved book rows and the shelf
 * percentage onto the device but never wrote a position to any config.json.
 * A user who synced and then went offline opened the book at the stale local
 * position, and only tapping sync *inside* the reader fixed it — the reader's
 * own pull needs the network, which is exactly what is gone by then.
 *
 * Applying the pulled configs here, while the network is still up, is what
 * makes a library sync mean "this device can now read offline from the synced
 * position".
 */

/** How many books' config.json files are loaded/merged in parallel. */
const APPLY_CONCURRENCY = 4;

/**
 * A malformed CFI is discarded, not persisted: `isMalformedLocationCfi` is the
 * same guard the reader applies to a synced location before it moves the view.
 */
const sanitizeLocation = (location: string | undefined): string =>
  location && !isMalformedLocationCfi(location) ? location : '';

/**
 * Merge the reading state of a pulled config into the local one, or return null
 * when there is nothing to apply.
 *
 * Only reading state crosses: `viewSettings` / `searchConfig` describe THIS
 * device's screen (the reader merges the two cross-device view keys —
 * proofreadRules, referencePageCount — itself on open), and `booknotes` ride the
 * separate `notes` channel, so a progress pull must never clobber them.
 */
export const mergeSyncedConfig = (local: BookConfig, remote: BookConfig): BookConfig | null => {
  const remoteLocation = sanitizeLocation(remote.location);
  const localLocation = sanitizeLocation(local.location);
  const remoteHasPosition = !!remoteLocation || !!remote.xpointer;
  const localHasPosition = !!localLocation || !!local.xpointer;
  // A config pushed for view settings only carries no position: adopting it
  // would only churn the local clock.
  if (!remoteHasPosition) return null;

  const remoteAt = remote.updatedAt ?? 0;
  const localAt = local.updatedAt ?? 0;

  // A local config that never had a position is stamped with "now" by
  // `deserializeConfig` (a missing `updatedAt` defaults to Date.now()), so a
  // pure clock comparison would ignore the remote forever on a book this device
  // has never read. An absent position always loses.
  if (localHasPosition && remoteAt <= localAt) return null;
  // Deliberately time-based, unlike the reader's own pull: `useProgressSync`
  // only moves when the remote CFI is AHEAD (CFI.compare) because it is moving
  // a live view. Here "the last device the user actually read on wins" is the
  // point — that is what an offline resume has to land on, and a deliberate
  // rewind on this device must not be dragged forward by a peer's older record.
  return {
    ...local,
    // A location without an XPointer means the pushing device could not resolve
    // one; drop the stale local XPointer in that case so the previous position
    // can't win the next merge (#7041). The local location is carried over only
    // when it survived the sanitizer: writing back a CFI this merge just
    // rejected would let a corrupt local location resume at page one again.
    location: remoteLocation || localLocation || undefined,
    xpointer: remoteLocation ? (remote.xpointer ?? '') : (remote.xpointer ?? local.xpointer),
    progress: remote.progress ?? local.progress,
    rsvpPosition: remote.rsvpPosition ?? local.rsvpPosition,
    updatedAt: remoteAt || localAt,
  };
};

export interface ApplySyncedConfigsOptions {
  envConfig: EnvConfigType;
  settings: SystemSettings;
  configs: readonly BookConfig[];
}

export interface ApplySyncedConfigsResult {
  /** How many local config.json files were updated. */
  applied: number;
  /**
   * Book hashes this device has no library row for (yet). The caller retries
   * once the book lands: a freshly pulled book row is inserted by
   * useBooksSync's batched `updateLibrary`, which can finish after the configs
   * pull resolves.
   */
  pending: Set<string>;
}

/**
 * Merge pulled configs into the local config.json of every book they belong to.
 * Never throws: one unreadable book must not abort the rest of the pull.
 */
export const applySyncedConfigsToLocal = async ({
  envConfig,
  settings,
  configs,
}: ApplySyncedConfigsOptions): Promise<ApplySyncedConfigsResult> => {
  const pending = new Set<string>();
  if (!configs.length) return { applied: 0, pending };

  const appService = await envConfig.getAppService();
  if (!appService) return { applied: 0, pending };

  // A book with a live view in this window owns its config in memory: writing a
  // pulled position to disk behind it would be overwritten by the reader's next
  // save, and that reader pulled its own progress when it opened.
  const openHashes = new Set(
    Object.keys(useReaderStore.getState().viewStates).map((key) => key.split('-')[0]!),
  );
  const { getBookByHash } = useLibraryStore.getState();

  // A millisecond-truncated pull cursor can replay a row; keep the newest.
  const byHash = new Map<string, BookConfig>();
  for (const config of configs) {
    const hash = config.bookHash;
    if (!hash) continue;
    const seen = byHash.get(hash);
    if (!seen || (config.updatedAt ?? 0) >= (seen.updatedAt ?? 0)) byHash.set(hash, config);
  }

  let applied = 0;
  // Bounded fan-out: a first sync can carry thousands of configs and every book
  // costs two disk round-trips. Applying them strictly one at a time held the
  // caller's sync lock for the whole run, during which a manual "Sync now" just
  // returned (useBooksSync's isPullingRef).
  const queue: [string, BookConfig][] = [];
  for (const [hash, remote] of byHash) {
    if (openHashes.has(hash)) continue;
    queue.push([hash, remote]);
  }
  for (let i = 0; i < queue.length; i += APPLY_CONCURRENCY) {
    const batch = queue.slice(i, i + APPLY_CONCURRENCY);
    await Promise.all(
      batch.map(async ([hash, remote]) => {
        const book = getBookByHash(hash);
        if (!book) {
          pending.add(hash);
          return;
        }
        // A deleted book's config outlives it on the server (a re-download of
        // the same file resumes from it), but resurrecting a position into a
        // deleted shelf row is meaningless.
        if (book.deletedAt) return;
        try {
          const local = await appService.loadBookConfig(book, settings);
          const merged = mergeSyncedConfig(local, remote);
          if (!merged) return;
          await appService.saveBookConfig(book, merged, settings);
          applied += 1;
        } catch (error) {
          console.warn('Failed to apply synced reading progress for book', hash, error);
        }
      }),
    );
  }
  // One line per library sync: the only way to tell a pull that found nothing
  // (cursor already past the record) from a merge that deliberately kept the
  // local position, which are indistinguishable from the outside.
  console.info('[sync] reading progress pull', {
    pulled: configs.length,
    applied,
    pending: pending.size,
  });
  return { applied, pending };
};
