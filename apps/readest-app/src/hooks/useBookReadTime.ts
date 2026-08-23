import { useEffect, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { StatisticsDb } from '@/services/statistics/statisticsDb';

/**
 * Total reading time for a book, in seconds, from its reading statistics —
 * `null` until the book has a statistics row. Mirrors
 * {@link useMedianPageDurationSecs}.
 */
export const useBookReadTime = (bookMd5?: string): number | null => {
  const { appService } = useEnv();
  const [readTimeSecs, setReadTimeSecs] = useState<number | null>(null);

  useEffect(() => {
    if (!appService || !bookMd5) return;

    const load = async () => {
      const db = await StatisticsDb.open(appService);
      const book = await db.getBookByMd5(bookMd5);
      setReadTimeSecs(book?.total_read_time ?? 0);
    };

    // Statistics are best-effort: a failed DB open/read (e.g. torn down on app
    // teardown) must never surface as an unhandled rejection (Sentry READEST-6).
    void load().catch((err) => console.warn('[stats] book read time failed:', err));
  }, [appService, bookMd5]);

  return readTimeSecs;
};
