'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useTheme } from '@/hooks/useTheme';
import { useThemeStore } from '@/store/themeStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useReadingStats } from '@/hooks/useReadingStats';
import { useLibraryStore } from '@/store/libraryStore';
import { useBookTransferActions } from '@/app/library/hooks/useBookTransferActions';
import { useMakeBookAvailable } from '@/hooks/useMakeBookAvailable';
import type { StatBookTotals } from '@/types/statistics';
import { navigateBackFromProfile, navigateToReader } from '@/utils/nav';
import { isAudiobook } from '@/utils/audiobook';
import { eventDispatcher } from '@/utils/event';
import Spinner from '@/components/Spinner';
import StatsHeader from './components/Header';
import ReadingChart, { type ChartRange } from './components/ReadingChart';
import TopBooksList from './components/TopBooksList';

// A ranking row shows an inline spinner instead of a percentage, so the
// transfer plumbing gets no-op sinks (module-scoped so the memoized callback
// below keeps a stable identity).
const noop = () => {};

const StatsPage = () => {
  const _ = useTranslation();
  const router = useRouter();
  const { appService, envConfig } = useEnv();
  const { safeAreaInsets, isRoundedWindow } = useThemeStore();
  const { data, loading, syncing, getTopBooksInRange } = useReadingStats();
  const updateBook = useLibraryStore((state) => state.updateBook);
  const { handleBookDownload } = useBookTransferActions(envConfig, appService, updateBook, noop);
  const makeBookAvailable = useMakeBookAvailable({ setLoading: noop, handleBookDownload });

  const [mounted, setMounted] = useState(false);
  const [rangeBooks, setRangeBooks] = useState<StatBookTotals[] | null>(null);
  const [rangeLabel, setRangeLabel] = useState<string | null>(null);
  const [pendingHash, setPendingHash] = useState<string | null>(null);

  useTheme({ systemUIVisible: false });

  const handleGoBack = () => {
    // 从阅读器进来时带 redirect：返回应回到正在读的书，而不是掉到书架。
    // navigateBackFromProfile 已校验 redirect 的形态，非法值自动回落书架。
    const redirect = new URLSearchParams(window.location.search).get('redirect');
    navigateBackFromProfile(router, redirect);
  };

  /**
   * Ranking rows open the book they name. This page can be reached without ever
   * visiting the shelf (a deep link, a cold start), so the library is read from
   * disk when the store has not been hydrated, and a cloud-only book is fetched
   * first — the same flow a home-screen widget tap takes.
   */
  const handleSelectBook = useCallback(
    async (entry: StatBookTotals) => {
      // A second tap while the first one is still downloading would start a
      // concurrent transfer for the same file.
      if (!appService || pendingHash === entry.bookMd5) return;
      setPendingHash(entry.bookMd5);
      try {
        const store = useLibraryStore.getState();
        let book = store.getBookByHash(entry.bookMd5);
        // A hydrated store already mirrors disk; re-reading it would also
        // revert anything the session has not persisted yet.
        if (!book && !store.libraryLoaded) {
          const library = await appService.loadLibraryBooks();
          store.setLibrary(library);
          book = useLibraryStore.getState().getBookByHash(entry.bookMd5);
        }
        if (!book) {
          eventDispatcher.dispatch('toast', {
            type: 'warning',
            timeout: 2500,
            message: _('Book not in your library'),
          });
          return;
        }
        if (isAudiobook(book)) {
          router.push(`/player?id=${book.hash}`);
          return;
        }
        // `handleBookDownload` only converts its own failures into a toast; a
        // throwing mirror or `updateBook` propagates out of `makeBookAvailable`.
        if (!(await makeBookAvailable(book))) return;
        navigateToReader(router, [book.hash]);
      } catch (error) {
        console.error('Failed to open book from stats:', error);
        eventDispatcher.dispatch('toast', {
          type: 'error',
          timeout: 3000,
          message: _('Failed to open book'),
        });
      } finally {
        setPendingHash(null);
      }
    },
    [appService, makeBookAvailable, pendingHash, router, _],
  );

  const handleRangeChange = useCallback(
    async (range: ChartRange) => {
      setRangeLabel(range.label ?? null);
      const books = await getTopBooksInRange(range.fromSec, range.toSec);
      setRangeBooks(books);
    },
    [getTopBooksInRange],
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const { overview, monthly, daily, topBooks } = data;
  const hasData = overview.totalReadSecs > 0;
  const isEmpty = !loading && !syncing && !hasData;
  const displayTopBooks = rangeBooks ?? topBooks;

  return (
    <div
      className={clsx(
        'bg-base-100 full-height inset-0 select-none overflow-hidden',
        appService?.hasRoundedWindow && isRoundedWindow && 'window-border rounded-window',
      )}
    >
      <div
        className='flex h-full w-full flex-col items-center overflow-y-auto'
        style={{
          paddingTop: `${safeAreaInsets?.top || 0}px`,
        }}
      >
        <StatsHeader onGoBack={handleGoBack} />
        {/* The header is `fixed` (it doubles as the window-bar drag strip), so it
            takes no layout space: without a spacer the first rows of content
            scroll underneath it. The spacer mirrors StatsHeader's own height —
            py-2 + the h-12 (phone) / h-8 (sm+) control row — plus its macOS
            `pt-11` traffic-light inset, so the two cannot drift apart. */}
        <div
          aria-hidden='true'
          className={clsx(
            'shrink-0',
            // pb-2(0.5rem) + 控件行 h-12 / sm:h-8; on macOS the traffic-light
            // inset pt-11(2.75rem) *replaces* the pt-2 of `py-2`:
            // 44 + 8 + 48 = 100px, and 44 + 8 + 32 = 84px from sm up.
            appService?.hasTrafficLight ? 'h-[6.25rem] sm:h-[5.25rem]' : 'h-16 sm:h-12',
          )}
        />
        <div className='mt-2 w-full min-w-60 max-w-2xl pb-10'>
          {loading ? (
            <div className='flex min-h-[300px] items-center justify-center'>
              <Spinner loading className='text-gray-900' />
            </div>
          ) : (
            <div className='flex flex-col gap-y-10 px-5 sm:px-6'>
              {isEmpty ? (
                <div className='text-neutral-content flex min-h-[300px] flex-col items-center justify-center gap-2 text-center'>
                  <p className='text-base-content text-lg font-semibold'>
                    {_('No reading data yet')}
                  </p>
                  <p className='text-sm'>
                    {_('Reading time is recorded while you read and synced across devices.')}
                  </p>
                </div>
              ) : (
                <>
                  <ReadingChart
                    monthly={monthly}
                    daily={daily}
                    overview={overview}
                    onRangeChange={handleRangeChange}
                  />
                  <TopBooksList
                    books={displayTopBooks}
                    title={rangeLabel ? `${rangeLabel} · ${_('Top 10 Books')}` : undefined}
                    onSelectBook={handleSelectBook}
                    pendingHash={pendingHash}
                  />
                </>
              )}
              {syncing && (
                <p className='text-neutral-content/60 flex items-center justify-center gap-2 text-xs'>
                  <span className='loading loading-spinner loading-xs' />
                  {_('Syncing reading stats...')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StatsPage;
