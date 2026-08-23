import { useEffect, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import { pullStats } from '@/services/statistics/statsSync';
import { SyncClient } from '@/libs/sync';
import { isSyncCategoryEnabled } from '@/services/sync/syncCategories';
import type { MonthlyReadTime, ReadingOverview, StatBookTotals } from '@/types/statistics';

export interface ReadingStatsData {
  overview: ReadingOverview;
  monthly: MonthlyReadTime[];
  topBooks: StatBookTotals[];
}

const EMPTY_STATS: ReadingStatsData = {
  overview: { totalReadSecs: 0, readingDays: 0, booksWithTime: 0 },
  monthly: [],
  topBooks: [],
};

const queryAll = async (db: StatisticsDb): Promise<ReadingStatsData> => ({
  overview: await db.getReadingOverview(),
  monthly: await db.getMonthlyReadTimes(),
  topBooks: await db.getTopBooksByReadTime(10),
});

/**
 * Reading statistics for the "My Reading" page. Shows the local database
 * immediately, then — when the stats sync category is on — merges the latest
 * events from the sync server (readest-sync-server) in the background and
 * refreshes, so a device that hasn't opened a book lately still sees its
 * full cross-device history.
 */
export const useReadingStats = () => {
  const { appService } = useEnv();
  const { user } = useAuth();
  const [data, setData] = useState<ReadingStatsData>(EMPTY_STATS);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!appService) return;
    let cancelled = false;

    const run = async () => {
      // Best-effort telemetry: a failed read/sync must never surface as an
      // unhandled rejection (matches the tracker's runBestEffort contract).
      try {
        const db = await StatisticsDb.open(appService);
        if (cancelled) return;
        setData(await queryAll(db));
      } catch (err) {
        console.warn('[stats] failed to load reading stats:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }

      if (!user || !isSyncCategoryEnabled('stats')) return;
      if (!cancelled) setSyncing(true);
      try {
        const db = await StatisticsDb.open(appService);
        await pullStats(db, new SyncClient());
        if (cancelled) return;
        setData(await queryAll(db));
      } catch (err) {
        console.warn('[stats] failed to sync reading stats:', err);
      } finally {
        if (!cancelled) setSyncing(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [appService, user]);

  return { data, loading, syncing };
};
