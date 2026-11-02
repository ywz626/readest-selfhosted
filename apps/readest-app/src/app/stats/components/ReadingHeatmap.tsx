import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import dayjs, { Dayjs } from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { useTranslation } from '@/hooks/useTranslation';
import { toDateKey } from '@/services/statistics/readingStats';
import { formatReadingDuration } from '@/utils/time';
import { getLocale } from '@/utils/misc';
import type { DailyReadTime } from '@/types/statistics';

dayjs.extend(isoWeek);

interface ReadingHeatmapProps {
  daily: DailyReadTime[];
  /** Render one calendar year; omit to stack every year that has data. */
  year?: number;
  /** Called with the clicked day, so the page can drill into it. */
  onSelectDay: (date: Dayjs) => void;
}

/**
 * Cells are fixed in height and stretch to the width of their flexible column,
 * so a row always fills the space it is given: no trailing blank on a phone, and
 * no horizontal scrolling on a desktop. `min-w-[6px]` is the floor that keeps a
 * cell clickable in an absurdly narrow window (the strip then scrolls).
 */
const CELL = 'h-3 w-full';
const CELL_MIN_WIDTH = 'min-w-[6px]';
const GAP = 'gap-[2px]';
/** Month-label row height (h-3) + its mb-1, used to align the weekday column. */
const WEEKDAY_OFFSET = 'mt-4';
/** Weekday gutter cell: fixed, unlike the stretching data cells. */
const WEEKDAY_CELL = 'h-3 w-3';
/** Legend swatches: fixed, unlike the stretching data cells. */
const LEGEND_CELL = 'h-3 w-3 rounded-[2px]';

/** Below this viewport width a year is stacked as two half-year rows. */
const ONE_ROW_MIN_WIDTH = 640;

/** Weekday rows are ISO (Monday first), matching the week tab's 一…日 labels. */
const WEEKDAY_ROWS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Five tinted steps. Reading time is absolute, so the buckets are absolute too:
 * a dark square means the same thing on every device, and a quiet year is not
 * exaggerated just because it happens to be the busiest one on record.
 *
 * `max` is inclusive: 15 minutes sharp still reads as "15 minutes", which is
 * what the reader showed them.
 */
const BUCKETS: Array<{ max: number; className: string }> = [
  { max: 15 * 60, className: 'bg-primary/25' },
  { max: 30 * 60, className: 'bg-primary/45' },
  { max: 60 * 60, className: 'bg-primary/65' },
  { max: 120 * 60, className: 'bg-primary/85' },
  { max: Number.POSITIVE_INFINITY, className: 'bg-primary' },
];

const EMPTY_CELL = 'bg-base-300/70';

/**
 * Tracks a `max-width` query. Deliberately hand-rolled instead of
 * `react-responsive`: that library memoizes a MediaQueryList per query string,
 * so a second render with a different viewport (a test, or a window moved
 * between monitors with different DPI) keeps answering from the first one.
 */
const useMaxWidth = (maxWidth: number): boolean => {
  const query = `(max-width: ${maxWidth}px)`;
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
};

/** Exported for the bucket-boundary test. */
export const bucketClass = (secs: number): string =>
  secs <= 0 ? EMPTY_CELL : (BUCKETS.find((bucket) => secs <= bucket.max)?.className ?? EMPTY_CELL);

/** Arrow steps: a day down a column, a week across columns. */
const KEY_STEPS: Record<string, number> = {
  ArrowUp: -1,
  ArrowDown: 1,
  ArrowLeft: -7,
  ArrowRight: 7,
};

interface HeatCell {
  key: string;
  date: Dayjs;
  inYear: boolean;
  secs: number;
}

interface HeatWeek {
  index: number;
  /** Month label rendered above this column, when a new month starts here. */
  monthLabel: string | null;
  cells: HeatCell[];
}

interface HeatYear {
  year: number;
  totalSecs: number;
  weeks: HeatWeek[];
}

type FocusedCell = Pick<HeatCell, 'key' | 'date' | 'secs'>;

interface TooltipState {
  x: number;
  y: number;
  above: boolean;
  text: string;
}

/** Exported for the grid maths test: ISO columns, one cell per in-year day. */
export const buildHeatmapYear = (year: number, secondsByDay: Map<string, number>): HeatYear => {
  const firstDay = dayjs(`${year}-01-01`).startOf('day');
  const lastDay = firstDay.endOf('year').startOf('day');
  // Align to the ISO week so every column is a full Mon…Sun week, exactly like
  // the week tab's grid; days outside the year render as invisible holes.
  const gridStart = firstDay.startOf('isoWeek');
  const weekCount = Math.ceil((lastDay.diff(gridStart, 'day') + 1) / 7);

  const weeks: HeatWeek[] = [];
  let previousMonth = -1;
  let totalSecs = 0;

  for (let w = 0; w < weekCount; w += 1) {
    const cells: HeatCell[] = [];
    for (let d = 0; d < 7; d += 1) {
      const date = gridStart.add(w * 7 + d, 'day');
      const inYear = date.year() === year;
      // One date-key format across the codebase (`YYYY-MM-DD`, zero padded), so
      // the day map built by the page joins with this lookup by construction.
      const key = toDateKey(date.toDate());
      const secs = inYear ? (secondsByDay.get(key) ?? 0) : 0;
      if (inYear) totalSecs += secs;
      cells.push({ key, date, inYear, secs });
    }

    // Label the month from the first in-year day of the column: the first
    // column usually still starts in the previous December, and labelling it
    // would print a stray month above a column with no data in this year.
    const firstInYear = cells.find((cell) => cell.inYear);
    let monthLabel: string | null = null;
    if (firstInYear) {
      const month = firstInYear.date.month();
      if (month !== previousMonth) {
        monthLabel = firstInYear.date.format('MMM');
        previousMonth = month;
      }
    }

    weeks.push({ index: w, monthLabel, cells });
  }

  return { year, totalSecs, weeks };
};

/**
 * Split a year's 53 ISO columns into two half-year rows, the phone layout. A
 * single 53-column strip cannot shrink its cells far enough to stay legible, so
 * Jan–Jun go on the first row and Jul–Dec on the second, split at the column
 * that holds July 1. That column still starts in June, so it keeps whichever
 * month label the full-year pass already gave it and the second row simply
 * begins without one.
 */
export const splitWeeksIntoRows = (weeks: HeatWeek[]): HeatWeek[][] => {
  if (weeks.length <= 27) return [weeks];
  let split = Math.ceil(weeks.length / 2);
  for (let i = 1; i < weeks.length; i += 1) {
    const startsSecondHalf = weeks[i]!.cells.some((cell) => cell.inYear && cell.date.month() >= 6);
    if (startsSecondHalf) {
      split = i;
      break;
    }
  }
  return [weeks.slice(0, split), weeks.slice(split)];
};

interface HeatDayCellProps {
  cell: HeatCell;
  /** Roving tab stop: only one cell of a year is tabbable. */
  tabbable: boolean;
  describe: (date: Dayjs, secs: number) => string;
  showTooltip: (element: HTMLElement, date: Dayjs, secs: number) => void;
  hideTooltip: () => void;
  onSelectDay: (date: Dayjs) => void;
  onFocusCell: (cell: FocusedCell) => void;
}

/**
 * Memoized on purpose: hovering a cell only changes the tooltip state in the
 * parent, and every prop here is a stable reference, so a year's 365 buttons
 * are not rebuilt (with a fresh `aria-label` each) on every hover.
 */
const HeatDayCell = memo(function HeatDayCell({
  cell,
  tabbable,
  describe,
  showTooltip,
  hideTooltip,
  onSelectDay,
  onFocusCell,
}: HeatDayCellProps) {
  return (
    <button
      type='button'
      data-date={cell.key}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => {
        hideTooltip();
        onSelectDay(cell.date);
      }}
      onMouseEnter={(e) => showTooltip(e.currentTarget, cell.date, cell.secs)}
      onMouseLeave={hideTooltip}
      onFocus={(e) => {
        onFocusCell({ key: cell.key, date: cell.date, secs: cell.secs });
        showTooltip(e.currentTarget, cell.date, cell.secs);
      }}
      onBlur={hideTooltip}
      aria-label={describe(cell.date, cell.secs)}
      className={clsx(
        CELL,
        'hover:ring-base-content/40 cursor-pointer rounded-[2px] transition-colors hover:ring-1',
        bucketClass(cell.secs),
      )}
    />
  );
});

/**
 * GitHub-style contribution calendar of reading time.
 *
 * Hover (or focus) shows that day's total; clicking drills into it — the page
 * switches to the Month tab with the day selected, which is what re-scopes the
 * "Top 10 books" ranking below to that day.
 *
 * Keyboard: the whole calendar is one tab stop, arrow keys step a day down a
 * column or a week across columns, and a live region announces the day — 366
 * focusable cells would otherwise trap a keyboard user in the tab order.
 */
const ReadingHeatmap: React.FC<ReadingHeatmapProps> = ({ daily, year, onSelectDay }) => {
  const _ = useTranslation();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [focused, setFocused] = useState<FocusedCell | null>(null);

  const locale = useMemo(() => getLocale(), []);
  // One formatter for the whole grid instead of one per cell per render.
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
    [locale],
  );

  // Monday first, a label only on Mon / Wed / Fri. dayjs is already pointed at
  // the app language by `initDayjs(settings.locale)`, so `ddd` localizes.
  const weekdayLabels = useMemo(
    () =>
      WEEKDAY_ROWS.map((row) =>
        row % 2 === 0 ? dayjs().startOf('isoWeek').add(row, 'day').format('ddd') : '',
      ),
    [],
  );

  const secondsByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of daily) {
      map.set(toDateKey(new Date(d.year, d.month - 1, d.day)), d.durationSecs);
    }
    return map;
  }, [daily]);

  const years = useMemo(() => {
    if (year !== undefined) return [year];
    return [...new Set(daily.map((d) => d.year))].sort((a, b) => b - a);
  }, [daily, year]);

  const grids = useMemo(
    () => years.map((y) => buildHeatmapYear(y, secondsByDay)),
    [years, secondsByDay],
  );

  // A 53-column strip only reads well once its cells stop shrinking, which needs
  // ~550px of grid. Where there is room the year is one row that fills the width;
  // where there is none (a phone) it is stacked as two half-year rows instead of
  // being panned sideways.
  const isCompact = useMaxWidth(ONE_ROW_MIN_WIDTH - 1);
  const rowsPerYear = useMemo(
    () => grids.map((grid) => (isCompact ? splitWeeksIntoRows(grid.weeks) : [grid.weeks])),
    [grids, isCompact],
  );

  const describe = useCallback(
    (date: Dayjs, secs: number) => {
      // Same source as the MMM month labels (the app locale), so a non-Chinese
      // UI never mixes localized months with hardcoded Chinese dates.
      const label = dateFormatter.format(date.toDate());
      return secs > 0
        ? `${label} · ${formatReadingDuration(secs, _)}`
        : `${label} · ${_('No reading data yet')}`;
    },
    [_, dateFormatter],
  );

  const hideTooltip = useCallback(() => setTooltip(null), []);

  const showTooltip = useCallback(
    (element: HTMLElement, date: Dayjs, secs: number) => {
      const rect = element.getBoundingClientRect();
      // Flip below the cell when there is no room above it (the grid can sit
      // right under the fixed page header on a short window).
      const above = rect.top > 56;
      setTooltip({
        x: rect.left + rect.width / 2,
        y: above ? rect.top - 6 : rect.bottom + 6,
        above,
        text: describe(date, secs),
      });
    },
    [describe],
  );

  // The bubble is `fixed` and `pointer-events-none`: once the page (or the
  // horizontal strip) scrolls it would hang over the wrong cell forever, since
  // no `mouseleave` fires while the pointer stays put.
  useEffect(() => {
    if (!tooltip) return;
    const dismiss = () => setTooltip(null);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [tooltip]);

  /** The single cell of a grid that holds the tab stop. */
  const tabStopKey = useCallback(
    (gridYear: number): string => {
      if (focused && focused.date.year() === gridYear) return focused.key;
      const today = dayjs();
      return today.year() === gridYear ? toDateKey(today.toDate()) : `${gridYear}-12-31`;
    },
    [focused],
  );

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    gridYear: number,
    currentKey: string,
  ) => {
    const step = KEY_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const next = dayjs(currentKey).add(step, 'day');
    if (next.year() !== gridYear) return;
    const nextKey = toDateKey(next.toDate());
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-date="${nextKey}"]`)?.focus();
  };

  if (grids.length === 0) return null;

  return (
    <div className='flex flex-col gap-5'>
      {grids.map((grid, gridIndex) => {
        const tabKey = tabStopKey(grid.year);
        const rows = rowsPerYear[gridIndex]!;
        return (
          <div key={grid.year} className='flex flex-col gap-2'>
            {year === undefined && (
              <h3 className='text-base-content/80 flex items-baseline gap-2 text-sm font-medium'>
                <span className='tabular-nums'>{grid.year}</span>
                <span className='text-neutral-content text-xs font-normal'>
                  {formatReadingDuration(grid.totalSecs, _)}
                </span>
              </h3>
            )}

            {/* One keyboard scope per year: the arrow keys step between rows too. */}
            <div
              role='group'
              aria-label={
                year === undefined ? `${_('Reading activity')} ${grid.year}` : _('Reading activity')
              }
              className='flex flex-col gap-2'
              onKeyDown={(e) => handleKeyDown(e, grid.year, tabKey)}
            >
              {/* One scroller for both half-year rows: separate scrollers (the
                  old layout) let the columns drift apart as the user pans. */}
              <div className='min-w-0 overflow-x-auto pb-1'>
                <div className='flex min-w-0 flex-col items-stretch gap-2'>
                  {rows.map((rowWeeks) => (
                    <div
                      key={`row-${rowWeeks[0]?.index ?? 0}`}
                      data-heatmap-row=''
                      className='flex min-w-0 gap-2'
                    >
                      {/* Weekday column: localized short names on every other row. */}
                      <div
                        className={clsx(
                          'flex w-3 shrink-0 flex-col items-end text-[9px] leading-none text-neutral-content',
                          GAP,
                          WEEKDAY_OFFSET,
                        )}
                        aria-hidden='true'
                      >
                        {WEEKDAY_ROWS.map((row) => (
                          <span
                            key={`wd-${row}`}
                            className={clsx(WEEKDAY_CELL, 'flex items-center')}
                          >
                            {weekdayLabels[row] ?? ''}
                          </span>
                        ))}
                      </div>

                      {/* Columns stretch to fill the row, so the heatmap ends
                          flush with the chart above it on every width. */}
                      <div className='flex min-w-0 flex-1 flex-col'>
                        <div
                          className={clsx(
                            'mb-1 flex h-3 text-[9px] leading-none text-neutral-content',
                            GAP,
                          )}
                          aria-hidden='true'
                        >
                          {rowWeeks.map((week) => (
                            <span
                              key={`m-${week.index}`}
                              className={clsx('relative flex-1', CELL_MIN_WIDTH)}
                            >
                              {week.monthLabel && (
                                <span className='absolute left-0 top-0 whitespace-nowrap'>
                                  {week.monthLabel}
                                </span>
                              )}
                            </span>
                          ))}
                        </div>
                        <div className={clsx('flex', GAP)}>
                          {rowWeeks.map((week) => (
                            <div
                              key={`w-${week.index}`}
                              className={clsx('flex flex-1 flex-col', CELL_MIN_WIDTH, GAP)}
                            >
                              {week.cells.map((cell) =>
                                cell.inYear ? (
                                  <HeatDayCell
                                    key={cell.key}
                                    cell={cell}
                                    tabbable={cell.key === tabKey}
                                    describe={describe}
                                    showTooltip={showTooltip}
                                    hideTooltip={hideTooltip}
                                    onSelectDay={onSelectDay}
                                    onFocusCell={setFocused}
                                  />
                                ) : (
                                  <span key={cell.key} className={CELL} aria-hidden />
                                ),
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className='text-neutral-content flex items-center justify-end gap-1 text-[10px]'>
              <span>{_('Less')}</span>
              <span className={clsx(LEGEND_CELL, EMPTY_CELL)} aria-hidden='true' />
              {BUCKETS.map((bucket) => (
                <span
                  key={`legend-${bucket.max}`}
                  className={clsx(LEGEND_CELL, bucket.className)}
                  aria-hidden='true'
                />
              ))}
              <span>{_('More')}</span>
            </div>
          </div>
        );
      })}

      {/* What the arrow keys land on, for screen readers. */}
      <span role='status' className='sr-only'>
        {focused ? describe(focused.date, focused.secs) : ''}
      </span>

      {tooltip && (
        // Fixed, so the horizontally scrolling grid cannot clip it.
        <div
          className={clsx(
            'bg-neutral text-neutral-content pointer-events-none fixed z-50 -translate-x-1/2 rounded-md px-2 py-1 text-[11px] whitespace-nowrap shadow-lg',
            tooltip.above && '-translate-y-full',
          )}
          style={{ left: tooltip.x, top: tooltip.y }}
          aria-hidden='true'
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
};

export default ReadingHeatmap;
