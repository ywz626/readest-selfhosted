'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useTheme } from '@/hooks/useTheme';
import { useThemeStore } from '@/store/themeStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useReadingStats } from '@/hooks/useReadingStats';
import { formatReadingDuration } from '@/utils/time';
import { navigateToLibrary } from '@/utils/nav';
import Spinner from '@/components/Spinner';
import StatsHeader from './components/Header';
import MonthlyChart from './components/MonthlyChart';
import TopBooksList from './components/TopBooksList';

const StatsPage = () => {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const { safeAreaInsets, isRoundedWindow } = useThemeStore();
  const { data, loading, syncing } = useReadingStats();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useTheme({ systemUIVisible: false });

  const handleGoBack = () => {
    navigateToLibrary(router);
  };

  if (!mounted) return null;

  const { overview, monthly, topBooks } = data;
  const totalHours = Math.floor(overview.totalReadSecs / 3600);
  const totalMinutes = Math.floor((overview.totalReadSecs % 3600) / 60);
  const hasData = overview.totalReadSecs > 0;
  const isEmpty = !loading && !syncing && !hasData;

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
                  <section
                    aria-label={_('Total Reading Time')}
                    className='bg-primary/5 flex flex-col gap-4 rounded-xl p-6'
                  >
                    <div className='flex items-baseline gap-2'>
                      <span className='text-primary text-4xl font-bold tabular-nums'>
                        {totalHours > 0 ? totalHours : totalMinutes}
                      </span>
                      <span className='text-primary/80 text-lg font-medium'>
                        {totalHours > 0 ? _('hours') : _('minutes')}
                      </span>
                    </div>
                    <span className='text-neutral-content text-sm'>
                      {formatReadingDuration(overview.totalReadSecs, _)}
                    </span>
                    <div className='border-base-200/70 flex gap-8 border-t pt-4'>
                      <div className='flex flex-col'>
                        <span className='text-base-content text-xl font-semibold tabular-nums'>
                          {overview.readingDays}
                        </span>
                        <span className='text-neutral-content/80 text-xs'>{_('Reading Days')}</span>
                      </div>
                      <div className='flex flex-col'>
                        <span className='text-base-content text-xl font-semibold tabular-nums'>
                          {overview.booksWithTime}
                        </span>
                        <span className='text-neutral-content/80 text-xs'>{_('Books Read')}</span>
                      </div>
                    </div>
                  </section>

                  <MonthlyChart monthly={monthly} />
                  <TopBooksList books={topBooks} />
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
