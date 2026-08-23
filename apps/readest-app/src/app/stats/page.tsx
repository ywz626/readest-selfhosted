'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useTheme } from '@/hooks/useTheme';
import { useThemeStore } from '@/store/themeStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useReadingStats } from '@/hooks/useReadingStats';
import type { StatBookTotals } from '@/types/statistics';
import { navigateToLibrary } from '@/utils/nav';
import Spinner from '@/components/Spinner';
import StatsHeader from './components/Header';
import ReadingChart, { type ChartRange } from './components/ReadingChart';
import TopBooksList from './components/TopBooksList';

const StatsPage = () => {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const { safeAreaInsets, isRoundedWindow } = useThemeStore();
  const { data, loading, syncing, getTopBooksInRange } = useReadingStats();

  const [mounted, setMounted] = useState(false);
  const [rangeBooks, setRangeBooks] = useState<StatBookTotals[] | null>(null);

  useTheme({ systemUIVisible: false });

  const handleGoBack = () => {
    navigateToLibrary(router);
  };

  const handleRangeChange = useCallback(
    async (range: ChartRange) => {
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
        <div className='w-full min-w-60 max-w-2xl py-10'>
          {loading ? (
            <div className='flex min-h-[300px] items-center justify-center'>
              <Spinner loading className='text-gray-900' />
            </div>
          ) : (
            <div className='flex flex-col gap-y-8 px-6'>
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
                  <TopBooksList books={displayTopBooks} />
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
