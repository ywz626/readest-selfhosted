// The config's `updatedAt` is the cross-device progress clock. Only a real
// page change may advance it: a book open/close or an annotation edit that
// merely re-saves the same position must not outrank the device the user
// actually read on, or the stale position is re-published as the newest
// record and the peer's newer one is rejected as "not newer".
import { beforeEach, describe, expect, test } from 'vitest';

import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import type { BookData } from '@/store/bookDataStore';

const makeBookData = (config: Record<string, unknown> = {}): BookData =>
  ({
    id: 'h1',
    book: null,
    file: null,
    config: { updatedAt: 1000, progress: [5, 10], location: 'cfi-5', ...config },
    bookDoc: null,
    isFixedLayout: false,
  }) as unknown as BookData;

const relocate = (currentPage: number, previewMode = false) => {
  useReaderStore.setState({
    viewStates: { 'h1-0': { isPrimary: true, previewMode } } as never,
  });
  useReaderStore
    .getState()
    .setProgress(
      'h1-0',
      `cfi-${currentPage + 1}`,
      null as never,
      null as never,
      { current: currentPage, total: 10 } as never,
      { current: currentPage, total: 10 } as never,
      {} as never,
      null as never,
      0.5,
    );
};

describe('setProgress progress clock', () => {
  beforeEach(() => {
    useBookDataStore.setState({ booksData: { h1: makeBookData() } });
  });

  test('stamps updatedAt when the page actually turns', () => {
    relocate(5);
    const config = useBookDataStore.getState().getConfig('h1')!;
    expect(config.progress).toEqual([6, 10]);
    expect(config.updatedAt).toBeGreaterThan(1000);
  });

  test('never lowers a stamp that is already published ahead of the clock', () => {
    // An older build stamped the config with the raw device clock and the server
    // already accepted it, so the record sits in the future. Dropping the stamp
    // would make our own push lose, and the next pull would put that record's
    // older position back over the page just read — until wall time catches up.
    const publishedAt = Date.now() + 60 * 60 * 1000;
    useBookDataStore.setState({ booksData: { h1: makeBookData({ updatedAt: publishedAt }) } });

    relocate(6);

    const config = useBookDataStore.getState().getConfig('h1')!;
    expect(config.progress).toEqual([7, 10]);
    expect(config.updatedAt).toBeGreaterThan(publishedAt);
  });

  test('keeps updatedAt when a relocate lands on the same page', () => {
    // Re-opening a book re-emits the position with a differently granularised
    // CFI; that is not movement.
    relocate(4);
    const config = useBookDataStore.getState().getConfig('h1')!;
    expect(config.updatedAt).toBe(1000);
  });

  test('leaves the progress clock alone when a view setting changes', () => {
    // Font size / theme / sidebar tab describe this screen, not the reading
    // position. Stamping the clock here re-published the current position as
    // the newest record on every UI tweak.
    useReaderStore.setState({
      viewStates: { 'h1-0': { isPrimary: true, previewMode: false, viewSettings: {} } } as never,
    });

    useReaderStore.getState().setViewSettings('h1-0', { fontSize: 20 } as never);

    const config = useBookDataStore.getState().getConfig('h1')!;
    expect(config.viewSettings).toEqual({ fontSize: 20 });
    expect(config.updatedAt).toBe(1000);
  });

  test('keeps updatedAt while previewing a deep link', () => {
    relocate(7, true);
    const config = useBookDataStore.getState().getConfig('h1')!;
    expect(config.updatedAt).toBe(1000);
  });
});
