import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string, opts?: Record<string, string | number>) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? '')),
}));

import MonthlyChart from '@/app/stats/components/MonthlyChart';
import TopBooksList from '@/app/stats/components/TopBooksList';
import { useReadingStats } from '@/hooks/useReadingStats';
import type { MonthlyReadTime, StatBookTotals } from '@/types/statistics';

afterEach(() => {
  cleanup();
});

describe('MonthlyChart', () => {
  const monthly: MonthlyReadTime[] = [
    { year: 2025, month: 12, durationSecs: 3600 },
    { year: 2026, month: 1, durationSecs: 7200 },
    { year: 2026, month: 3, durationSecs: 1800 },
  ];

  it('renders one bar button per month and a tab per year', () => {
    render(<MonthlyChart monthly={monthly} />);
    // 12 month bars + 2 year tabs = 14 buttons.
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(14);
    expect(screen.getByText('2025')).toBeDefined();
    expect(screen.getByText('2026')).toBeDefined();
  });

  it('shows the selected year total in the detail line', () => {
    render(<MonthlyChart monthly={monthly} />);
    // Latest year (2026) selected by default: 7200 + 1800 s.
    expect(screen.getByText('2 h 30 min')).toBeDefined();
  });

  it('selects a month on click and shows its duration', () => {
    render(<MonthlyChart monthly={monthly} />);
    // Buttons: [2025, 2026, Jan..Dec] — March is index 4.
    const march = screen.getAllByRole('button')[4]!;
    fireEvent.click(march);
    expect(screen.getByText('Mar · 30 min')).toBeDefined();
  });

  it('renders nothing without data', () => {
    const { container } = render(<MonthlyChart monthly={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('TopBooksList', () => {
  const books: StatBookTotals[] = [
    {
      bookMd5: 'm1',
      title: 'Book One',
      authors: 'Author A',
      totalReadTime: 7200,
      totalReadPages: 30,
      lastOpen: 100,
      pages: 300,
    },
    {
      bookMd5: 'm2',
      title: 'Book Two',
      authors: 'Author B',
      totalReadTime: 3600,
      totalReadPages: 10,
      lastOpen: 200,
      pages: 200,
    },
  ];

  it('ranks books with their reading durations', () => {
    render(<TopBooksList books={books} />);
    expect(screen.getByText('Book One')).toBeDefined();
    expect(screen.getByText('Book Two')).toBeDefined();
    expect(screen.getByText('2 h')).toBeDefined();
    expect(screen.getByText('1 h')).toBeDefined();
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('keeps its heading and explains an empty range', () => {
    render(<TopBooksList books={[]} title='8月12日 · Top 10 Books' />);
    expect(screen.getByRole('heading', { name: '8月12日 · Top 10 Books' })).toBeDefined();
    expect(screen.getByText('No reading data yet')).toBeDefined();
  });

  it('disables the row whose book is still opening', () => {
    render(<TopBooksList books={books} onSelectBook={() => {}} pendingHash='m1' />);
    const pending = screen.getByText('Book One').closest('button')!;
    const idle = screen.getByText('Book Two').closest('button')!;

    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(idle.disabled).toBe(false);
  });
});

const syncMocks = vi.hoisted(() => {
  const overview = { totalReadSecs: 100, readingDays: 1, booksWithTime: 1 };
  return {
    user: null as { id: string } | null,
    syncEnabled: false,
    // Stable object identity across renders — the real EnvContext memoizes
    // its value; a fresh object per render would re-run the effect every
    // re-render.
    appService: {},
    pullStats: vi.fn(async () => {}),
    getReadingOverview: vi.fn(async () => overview),
    getMonthlyReadTimes: vi.fn(async () => [{ year: 2026, month: 8, durationSecs: 100 }] as never),
    getTopBooksByReadTime: vi.fn(async () => [] as never),
  };
});

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: syncMocks.appService }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: syncMocks.user }) }));
vi.mock('@/services/statistics/statisticsDb', () => ({
  StatisticsDb: {
    open: vi.fn(async () => ({
      getReadingOverview: syncMocks.getReadingOverview,
      getMonthlyReadTimes: syncMocks.getMonthlyReadTimes,
      getTopBooksByReadTime: syncMocks.getTopBooksByReadTime,
    })),
  },
}));
vi.mock('@/services/statistics/statsSync', () => ({ pullStats: syncMocks.pullStats }));
vi.mock('@/libs/sync', () => ({ SyncClient: class {} }));
vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => syncMocks.syncEnabled,
}));

describe('useReadingStats', () => {
  const mocks = syncMocks;

  const Probe = () => {
    const { loading } = useReadingStats();
    return <div data-testid='probe'>{loading ? 'loading' : 'ready'}</div>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = null;
    mocks.syncEnabled = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries local data once without pulling when signed out', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready'));
    expect(mocks.getReadingOverview).toHaveBeenCalledTimes(1);
    expect(mocks.pullStats).not.toHaveBeenCalled();
  });

  it('pulls from the sync server and re-queries when sync is enabled', async () => {
    mocks.user = { id: 'u1' };
    mocks.syncEnabled = true;
    render(<Probe />);
    await waitFor(() => expect(mocks.pullStats).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.getReadingOverview).toHaveBeenCalledTimes(2));
  });
});
