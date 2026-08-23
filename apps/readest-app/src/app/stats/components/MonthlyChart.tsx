import { useMemo, useState } from 'react';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { useTranslation } from '@/hooks/useTranslation';
import { formatReadingDuration } from '@/utils/time';
import type { MonthlyReadTime } from '@/types/statistics';

interface MonthlyChartProps {
  monthly: MonthlyReadTime[];
}

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/** Reading-time bar chart with a year switcher, in the WeChat Read style. */
const MonthlyChart: React.FC<MonthlyChartProps> = ({ monthly }) => {
  const _ = useTranslation();

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

  const years = useMemo(() => [...byYear.keys()].sort((a, b) => b - a), [byYear]);
  const [selectedYear, setSelectedYear] = useState<number | null>(years[0] ?? null);

  // Keep the selection on a year that still exists when data refreshes.
  const activeYear = selectedYear && byYear.has(selectedYear) ? selectedYear : (years[0] ?? null);
  const yearMonths = activeYear !== null ? (byYear.get(activeYear) ?? new Map()) : new Map();
  const yearTotal = useMemo(
    () => [...yearMonths.values()].reduce((sum, d) => sum + d, 0),
    [yearMonths],
  );

  const maxDuration = useMemo(
    () => Math.max(1, ...MONTHS.map((m) => yearMonths.get(m) ?? 0)),
    [yearMonths],
  );

  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const selectedDuration = selectedMonth !== null ? (yearMonths.get(selectedMonth) ?? 0) : null;

  if (years.length === 0) return null;

  return (
    <section aria-label={_('Reading Time by Month')} className='flex flex-col gap-3'>
      <div className='flex items-center justify-between'>
        <h2 className='text-base-content text-base font-semibold'>{_('Reading Time by Month')}</h2>
        <div className='flex items-center gap-1'>
          {years.map((year) => (
            <button
              key={year}
              onClick={() => {
                setSelectedYear(year);
                setSelectedMonth(null);
              }}
              className={clsx(
                'btn btn-xs h-7 min-h-7 rounded-full px-3 text-xs font-normal',
                year === activeYear ? 'btn-contrast' : 'btn-ghost text-neutral-content',
              )}
              aria-pressed={year === activeYear}
            >
              {year}
            </button>
          ))}
        </div>
      </div>

      <div className='text-neutral-content flex items-baseline justify-between text-sm'>
        <span>
          {selectedMonth !== null
            ? `${dayjs()
                .month(selectedMonth - 1)
                .format('MMM')} · ${formatReadingDuration(selectedDuration ?? 0, _)}`
            : formatReadingDuration(yearTotal, _)}
        </span>
        <span className='text-xs'>{_('{{year}} total', { year: activeYear ?? '' })}</span>
      </div>

      <div className='flex h-36 gap-1.5 sm:gap-2'>
        {MONTHS.map((month) => {
          const duration = yearMonths.get(month) ?? 0;
          const isSelected = selectedMonth === month;
          return (
            <button
              key={month}
              onClick={() => setSelectedMonth(isSelected ? null : month)}
              className='group flex h-full flex-1 cursor-pointer flex-col items-center gap-1.5'
              aria-label={`${dayjs()
                .month(month - 1)
                .format('MMM')} ${formatReadingDuration(duration, _)}`}
            >
              <div className='flex w-full flex-1 items-end justify-center'>
                <div
                  className={clsx(
                    'w-full max-w-8 rounded-t-[3px] transition-colors',
                    duration === 0
                      ? 'bg-base-300/60 h-[3px]'
                      : isSelected
                        ? 'bg-primary'
                        : 'bg-primary/50 group-hover:bg-primary/75',
                  )}
                  style={
                    duration > 0
                      ? { height: `${Math.max(4, Math.round((duration / maxDuration) * 100))}%` }
                      : undefined
                  }
                />
              </div>
              <span
                className={clsx(
                  'text-neutral-content text-[10px] leading-none',
                  isSelected && 'text-base-content font-semibold',
                )}
              >
                {month}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

export default MonthlyChart;
