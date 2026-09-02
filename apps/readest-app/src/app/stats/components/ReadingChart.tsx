import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import dayjs, { Dayjs } from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { useTranslation } from '@/hooks/useTranslation';
import { formatReadingDuration } from '@/utils/time';
import type { DailyReadTime, MonthlyReadTime, ReadingOverview } from '@/types/statistics';

dayjs.extend(isoWeek);

export type ChartTab = 'week' | 'month' | 'year' | 'total';

export interface ChartRange {
  tab: ChartTab;
  /** inclusive start (unix seconds); null when tab === 'total' (all-time) */
  fromSec: number | null;
  /** exclusive end (unix seconds); null when tab === 'total' (all-time) */
  toSec: number | null;
  /** localized label of the narrowed scope, e.g. "8月12日" (only when a specific unit is selected) */
  label?: string;
}

interface ReadingChartProps {
  monthly: MonthlyReadTime[];
  daily: DailyReadTime[];
  overview: ReadingOverview;
  onRangeChange?: (range: ChartRange) => void;
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/** Reading-time bar chart with Week/Month/Year/Total tabs. */
const ReadingChart = ({ monthly, daily, overview, onRangeChange }: ReadingChartProps) => {
  const _ = useTranslation();
  const [activeTab, setActiveTab] = useState<ChartTab>('week');

  // --- Data processing ---
  const byYear = useMemo(() => {
    const map = new Map<number, Map<number, number>>();
    for (const m of monthly) {
      let months = map.get(m.year);
      if (!months) {
        months = new Map<number, number>();
        map.set(m.year, months);
      }
      months.set(m.month, m.durationSecs);
    }
    return map;
  }, [monthly]);

  const byYearMonthDay = useMemo(() => {
    const map = new Map<number, Map<number, Map<number, number>>>();
    for (const d of daily) {
      let months = map.get(d.year);
      if (!months) {
        months = new Map<number, Map<number, number>>();
        map.set(d.year, months);
      }
      let days = months.get(d.month);
      if (!days) {
        days = new Map<number, number>();
        months.set(d.month, days);
      }
      days.set(d.day, d.durationSecs);
    }
    return map;
  }, [daily]);

  // --- Year View State ---
  const years = useMemo(() => [...byYear.keys()].sort((a, b) => b - a), [byYear]);
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(
    years.includes(currentYear) ? currentYear : (years[0] ?? currentYear),
  );
  const yearMonths = byYear.get(selectedYear) ?? new Map<number, number>();
  const yearTotal = useMemo(
    () => [...yearMonths.values()].reduce((sum, d) => sum + d, 0),
    [yearMonths],
  );
  const maxYearMonth = useMemo(
    () => Math.max(1, ...MONTHS.map((m) => yearMonths.get(m) ?? 0)),
    [yearMonths],
  );
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const selectedMonthDuration =
    selectedMonth !== null ? (yearMonths.get(selectedMonth) ?? 0) : null;

  // --- Month View State ---
  const [selectedMonthDate, setSelectedMonthDate] = useState<Dayjs>(dayjs().startOf('month'));
  const yearMonthDays =
    byYearMonthDay.get(selectedMonthDate.year())?.get(selectedMonthDate.month() + 1) ??
    new Map<number, number>();
  const daysInMonth = selectedMonthDate.daysInMonth();
  const monthTotal = useMemo(
    () => [...yearMonthDays.values()].reduce((sum, d) => sum + d, 0),
    [yearMonthDays],
  );
  const maxMonthDay = useMemo(
    () =>
      Math.max(
        1,
        ...Array.from({ length: daysInMonth }, (_, i) => i + 1).map(
          (d) => yearMonthDays.get(d) ?? 0,
        ),
      ),
    [yearMonthDays, daysInMonth],
  );
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const selectedDayDuration = selectedDay !== null ? (yearMonthDays.get(selectedDay) ?? 0) : null;

  // --- Week View State ---
  const [selectedWeekStart, setSelectedWeekStart] = useState<Dayjs>(dayjs().startOf('isoWeek'));
  const weekDays = useMemo(() => {
    const start = selectedWeekStart;
    return Array.from({ length: 7 }, (_, i) => start.add(i, 'day'));
  }, [selectedWeekStart]);
  const weekDurations = useMemo(() => {
    return weekDays.map((d) => {
      const daysMap = byYearMonthDay.get(d.year())?.get(d.month() + 1);
      return daysMap?.get(d.date()) ?? 0;
    });
  }, [weekDays, byYearMonthDay]);
  const weekTotal = useMemo(() => weekDurations.reduce((sum, d) => sum + d, 0), [weekDurations]);
  const maxWeekDay = useMemo(() => Math.max(1, ...weekDurations), [weekDurations]);
  const [selectedWeekDay, setSelectedWeekDay] = useState<number | null>(null);
  const selectedWeekDuration = selectedWeekDay !== null ? weekDurations[selectedWeekDay] : null;

  // --- Handlers ---
  const goPrevMonth = () => setSelectedMonthDate(selectedMonthDate.subtract(1, 'month'));
  const goNextMonth = () => setSelectedMonthDate(selectedMonthDate.add(1, 'month'));
  const goPrevWeek = () => setSelectedWeekStart(selectedWeekStart.subtract(1, 'week'));
  const goNextWeek = () => setSelectedWeekStart(selectedWeekStart.add(1, 'week'));
  const goPrevYear = () => {
    const newYear = selectedYear - 1;
    setSelectedYear(newYear);
    setSelectedMonth(null);
  };
  const goNextYear = () => {
    const newYear = selectedYear + 1;
    setSelectedYear(newYear);
    setSelectedMonth(null);
  };

  // --- Range reporting ---
  const currentRange = useMemo<ChartRange>(() => {
    if (activeTab === 'total') return { tab: 'total', fromSec: null, toSec: null };
    if (activeTab === 'week') {
      const start = selectedWeekStart.startOf('day');
      const end = selectedWeekStart.add(7, 'day').startOf('day');
      if (selectedWeekDay !== null) {
        const dayStart = weekDays[selectedWeekDay]!.startOf('day');
        return {
          tab: 'week',
          fromSec: dayStart.unix(),
          toSec: dayStart.add(1, 'day').unix(),
          label: weekDays[selectedWeekDay]!.format('M月D日'),
        };
      }
      return {
        tab: 'week',
        fromSec: start.unix(),
        toSec: end.unix(),
      };
    }
    if (activeTab === 'month') {
      const start = selectedMonthDate.startOf('month');
      const end = selectedMonthDate.add(1, 'month').startOf('month');
      if (selectedDay !== null) {
        const dayStart = selectedMonthDate.date(selectedDay).startOf('day');
        return {
          tab: 'month',
          fromSec: dayStart.unix(),
          toSec: dayStart.add(1, 'day').unix(),
          label: dayStart.format('M月D日'),
        };
      }
      return {
        tab: 'month',
        fromSec: start.unix(),
        toSec: end.unix(),
      };
    }
    // year — drilling into a month switches to the Month tab, so the whole-year
    // range stays as-is here.
    const start = dayjs(`${selectedYear}-01-01`).startOf('year');
    const end = start.add(1, 'year');
    return {
      tab: 'year',
      fromSec: start.unix(),
      toSec: end.unix(),
    };
  }, [
    activeTab,
    selectedWeekStart,
    selectedMonthDate,
    selectedYear,
    selectedWeekDay,
    selectedDay,
    weekDays,
  ]);

  useEffect(() => {
    onRangeChange?.(currentRange);
  }, [currentRange, onRangeChange]);

  // --- Render Helpers ---
  const renderNavigation = (tab: ChartTab) => {
    const prev = <span className='text-lg leading-none'>{'<'}</span>;
    const next = <span className='text-lg leading-none'>{'>'}</span>;
    if (tab === 'year') {
      return (
        <div className='flex items-center gap-2 text-sm font-medium'>
          <button onClick={goPrevYear} className='btn btn-ghost btn-sm h-7 min-h-7 w-7 p-0'>
            {prev}
          </button>
          <span>{selectedYear}年</span>
          <button onClick={goNextYear} className='btn btn-ghost btn-sm h-7 min-h-7 w-7 p-0'>
            {next}
          </button>
        </div>
      );
    }
    if (tab === 'month') {
      return (
        <div className='flex items-center gap-2 text-sm font-medium'>
          <button onClick={goPrevMonth} className='btn btn-ghost btn-sm h-7 min-h-7 w-7 p-0'>
            {prev}
          </button>
          <span>
            {selectedMonthDate.year()}年{selectedMonthDate.month() + 1}月
          </span>
          <button onClick={goNextMonth} className='btn btn-ghost btn-sm h-7 min-h-7 w-7 p-0'>
            {next}
          </button>
        </div>
      );
    }
    if (tab === 'week') {
      const end = selectedWeekStart.add(6, 'day');
      return (
        <div className='flex items-center gap-2 text-sm font-medium'>
          <button onClick={goPrevWeek} className='btn btn-ghost btn-sm h-7 min-h-7 w-7 p-0'>
            {prev}
          </button>
          <span className='text-xs'>
            {selectedWeekStart.format('M月D日')} 至 {end.format('M月D日')}
          </span>
          <button onClick={goNextWeek} className='btn btn-ghost btn-sm h-7 min-h-7 w-7 p-0'>
            {next}
          </button>
        </div>
      );
    }
    return null;
  };

  /**
   * Unified chart layout:
   *   ┌──y-axis (right-aligned)──┬──plot area (fixed h-32, the SOURCE OF TRUTH)──┐
   *   │         tick 3           │  grid line 3 (absolute top)                │
   *   │         tick 2           │  grid line 2                              │
   *   │         tick 1           │  grid line 1                              │
   *   │         tick 0           │  grid line 0 (baseline) + bars            │
   *   └──────────────────────────┴────────────────────────────────────────────┘
   *   ┌──y-axis labels (no height)┬──x-axis labels row (same width as plot)────┐
   *
   * Bar heights are computed as (duration / scaleMax) % of the h-32 plot area,
   * so a 100%-tall bar sits exactly on the top gridline (= scaleMax tick).
   * The X-axis labels live OUTSIDE the plot area so they don't steal bar height.
   */
  const PLOT_HEIGHT = 'h-32'; // 128px; shared reference for bars, grid, ticks

  /** Build nice round tick values for the Y axis (0, 1/3, 2/3, max). */
  const buildYTicks = (max: number): number[] => {
    if (max <= 0) return [0];
    const raw = max;
    let step: number;
    if (raw <= 3600) step = Math.ceil(raw / 3 / 600) * 600 || 300;
    else if (raw <= 86400) step = Math.ceil(raw / 3 / 3600) * 3600 || 1800;
    else step = Math.ceil(raw / 3 / 3600 / 6) * 3600 * 6 || 3600;
    const top = Math.ceil(raw / step) * step;
    return [0, Math.round(top / 3), Math.round((top * 2) / 3), top];
  };

  const formatTick = (sec: number): string => {
    if (sec === 0) return '0';
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  };

  const currentMax =
    activeTab === 'week'
      ? maxWeekDay
      : activeTab === 'month'
        ? maxMonthDay
        : activeTab === 'year'
          ? maxYearMonth
          : 0;
  const yTicks = useMemo(() => buildYTicks(currentMax), [currentMax]);
  const scaleMax = yTicks[yTicks.length - 1] ?? currentMax;

  type BarRenderer = (
    duration: number,
    isSelected: boolean,
    label: string,
    onClick: () => void,
  ) => React.ReactNode;

  const makeBarRenderer =
    (tabMax: number, labels: string[]): BarRenderer =>
    (duration, isSelected, label, onClick) => {
      void label; // label rendered outside; kept for API uniformity
      void labels;
      return (
        <button
          onClick={onClick}
          className={clsx(
            'group relative flex h-full min-w-0 flex-1 cursor-pointer items-end justify-center',
            isSelected && 'z-10',
          )}
          aria-label={`${label} ${formatReadingDuration(duration, _)}`}
        >
          <div
            className={clsx(
              'w-full max-w-8 self-end rounded-t-[3px] transition-colors',
              duration === 0
                ? 'bg-base-300/60 h-[3px]'
                : isSelected
                  ? 'bg-primary'
                  : 'bg-primary/50 group-hover:bg-primary/75',
            )}
            style={
              duration > 0
                ? { height: `${Math.max(4, Math.round((duration / tabMax) * 100))}%` }
                : undefined
            }
          />
        </button>
      );
    };

  /** Layout: left Y-axis column (plot + tick labels below) + right column (plot + x labels) */
  const renderChartWithYAxis = (plotContent: React.ReactNode, xLabels: React.ReactNode) => (
    <div className='flex gap-2'>
      {/* Left column: y-axis ticks + spacer for x-label row */}
      <div className='flex w-10 shrink-0 flex-col'>
        <div
          className={`relative flex ${PLOT_HEIGHT} flex-col justify-between text-right text-[10px] text-neutral-content`}
        >
          {[...yTicks].reverse().map((tick) => (
            <span key={tick} className='leading-none'>
              {formatTick(tick)}
            </span>
          ))}
        </div>
        {/* Spacer matching the x-label row height */}
        <div className='text-[10px] leading-none'>&nbsp;</div>
      </div>

      {/* Right column: plot area + x-axis labels */}
      <div className='flex min-w-0 flex-1 flex-col'>
        <div className={`relative ${PLOT_HEIGHT}`}>
          {/* Grid lines – absolutely positioned so they share the exact height */}
          <div className='pointer-events-none absolute inset-0 flex flex-col justify-between'>
            {yTicks.map((_tick, i) => (
              <div
                key={`grid-${i}`}
                className={clsx(
                  'h-px w-full',
                  i === 0 ? 'bg-base-300' : 'border-t border-dashed border-base-300',
                )}
              />
            ))}
          </div>
          {plotContent}
        </div>
        {/* X-axis labels, OUTSIDE the plot area */}
        <div className='flex items-start gap-1.5 pt-1 text-[10px] leading-none text-neutral-content sm:gap-2'>
          {xLabels}
        </div>
      </div>
    </div>
  );

  // --- Main Render ---
  return (
    <section aria-label={_('Reading Time Distribution')} className='flex flex-col gap-3'>
      <div className='flex items-center justify-between'>
        <h2 className='text-base-content text-base font-semibold'>
          {_('Reading Time Distribution')}
        </h2>
        <div role='tablist' className='tabs tabs-boxed h-8'>
          {(['week', 'month', 'year', 'total'] as ChartTab[]).map((tab) => (
            <button
              key={tab}
              role='tab'
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={clsx('tab h-7 min-h-7 px-3 text-xs', activeTab === tab && 'tab-active')}
            >
              {_(
                tab === 'week'
                  ? 'Week'
                  : tab === 'month'
                    ? 'Month'
                    : tab === 'year'
                      ? 'Year'
                      : 'Total',
              )}
            </button>
          ))}
        </div>
      </div>

      {activeTab !== 'total' && (
        <div className='flex items-center justify-between'>
          <div className='text-neutral-content text-sm'>
            {activeTab === 'week' &&
              (selectedWeekDuration !== null && selectedWeekDay !== null
                ? `${weekDays[selectedWeekDay]?.format('ddd') ?? ''} · ${formatReadingDuration(selectedWeekDuration ?? 0, _)}`
                : formatReadingDuration(weekTotal, _))}
            {activeTab === 'month' &&
              (selectedDayDuration !== null
                ? `${selectedDay}日 · ${formatReadingDuration(selectedDayDuration, _)}`
                : formatReadingDuration(monthTotal, _))}
            {activeTab === 'year' &&
              years.length > 0 &&
              (selectedMonthDuration !== null && selectedMonth !== null
                ? `${dayjs()
                    .month(selectedMonth - 1)
                    .format('MMM')} · ${formatReadingDuration(selectedMonthDuration, _)}`
                : formatReadingDuration(yearTotal, _))}
          </div>
          {renderNavigation(activeTab)}
        </div>
      )}

      {activeTab === 'week' &&
        (() => {
          const bar = makeBarRenderer(scaleMax, ['一', '二', '三', '四', '五', '六', '日']);
          return renderChartWithYAxis(
            <div className='absolute inset-0 flex items-end gap-1.5 sm:gap-2'>
              {weekDays.map((_d, i) => {
                const duration = weekDurations[i]!;
                const isSelected = selectedWeekDay === i;
                return bar(
                  duration,
                  isSelected,
                  ['一', '二', '三', '四', '五', '六', '日'][i] ?? '',
                  () => setSelectedWeekDay(isSelected ? null : i),
                );
              })}
            </div>,
            weekDays.map((_d, i) => {
              const isSelected = selectedWeekDay === i;
              return (
                <span
                  key={`wlabel-${i}`}
                  className={clsx(
                    'flex-1 text-center',
                    isSelected && 'text-base-content font-semibold',
                  )}
                >
                  {['一', '二', '三', '四', '五', '六', '日'][i]}
                </span>
              );
            }),
          );
        })()}

      {activeTab === 'month' &&
        (() => {
          const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
          const bar = makeBarRenderer(scaleMax, days.map(String));
          return renderChartWithYAxis(
            <div className='absolute inset-0 flex items-end gap-1.5 sm:gap-2'>
              {days.map((day) => {
                const duration = yearMonthDays.get(day) ?? 0;
                const isSelected = selectedDay === day;
                return bar(duration, isSelected, `${day}日`, () =>
                  setSelectedDay(isSelected ? null : day),
                );
              })}
            </div>,
            days.map((day) => {
              const isSelected = selectedDay === day;
              return (
                <span
                  key={`mlabel-${day}`}
                  className={clsx(
                    'flex-1 text-center',
                    isSelected && 'text-base-content font-semibold',
                  )}
                >
                  {day}
                </span>
              );
            }),
          );
        })()}

      {activeTab === 'year' &&
        years.length > 0 &&
        (() => {
          const bar = makeBarRenderer(scaleMax, MONTHS.map(String));
          return renderChartWithYAxis(
            <div className='absolute inset-0 flex items-end gap-1.5 sm:gap-2'>
              {MONTHS.map((month) => {
                const duration = yearMonths.get(month) ?? 0;
                const isSelected = selectedMonth === month;
                return bar(duration, isSelected, `${month}`, () => {
                  // Drill down: jump to the Month tab positioned at this month,
                  // where the user can then pick a specific day.
                  setSelectedMonth(month);
                  setSelectedDay(null);
                  setSelectedMonthDate(
                    dayjs()
                      .year(selectedYear)
                      .month(month - 1)
                      .startOf('month'),
                  );
                  setActiveTab('month');
                });
              })}
            </div>,
            MONTHS.map((month) => {
              const isSelected = selectedMonth === month;
              return (
                <span
                  key={`ylabel-${month}`}
                  className={clsx(
                    'flex-1 text-center',
                    isSelected && 'text-base-content font-semibold',
                  )}
                >
                  {month}
                </span>
              );
            }),
          );
        })()}

      {activeTab === 'total' && (
        <div className='bg-primary/5 flex flex-col gap-4 rounded-xl p-6'>
          <div className='flex items-baseline gap-2'>
            <span className='text-primary text-4xl font-bold tabular-nums'>
              {Math.floor(overview.totalReadSecs / 3600)}
            </span>
            <span className='text-primary/80 text-lg font-medium'>{_('hours')}</span>
            <span className='text-primary/50 text-lg font-medium'>
              {Math.floor((overview.totalReadSecs % 3600) / 60)} {_('minutes')}
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
        </div>
      )}
    </section>
  );
};

export default ReadingChart;
