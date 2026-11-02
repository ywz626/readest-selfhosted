import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import {
  bucketClass,
  buildHeatmapYear,
  splitWeeksIntoRows,
} from '@/app/stats/components/ReadingHeatmap';

/**
 * The GitHub-style calendar must place every day of the year exactly once, on
 * ISO weeks (Monday first) — the same grid the week tab uses. An off-by-one
 * here silently drops a day or duplicates one, which the chart cannot show.
 */
describe('buildHeatmapYear', () => {
  const inYearCells = (grid: ReturnType<typeof buildHeatmapYear>) =>
    grid.weeks.flatMap((week) => week.cells.filter((cell) => cell.inYear));

  it('lays out a leap year without dropping or duplicating a day', () => {
    const grid = buildHeatmapYear(2024, new Map());
    const cells = inYearCells(grid);

    expect(cells).toHaveLength(366);
    expect(new Set(cells.map((cell) => cell.key)).size).toBe(366);
    expect(cells[0]!.date.format('YYYY-MM-DD')).toBe('2024-01-01');
    expect(cells[cells.length - 1]!.date.format('YYYY-MM-DD')).toBe('2024-12-31');
    // Every column starts on a Monday (dayjs: 0 = Sunday).
    for (const week of grid.weeks) {
      expect(week.cells[0]!.date.day()).toBe(1);
    }
  });

  it('sums only the days inside the year', () => {
    const grid = buildHeatmapYear(
      2026,
      new Map([
        // Zero-padded YYYY-MM-DD, the shared `toDateKey` format.
        ['2026-01-05', 600],
        ['2026-01-06', 300],
        // Belongs to the previous year, but sits in 2026's first column.
        ['2025-12-30', 9999],
      ]),
    );

    expect(grid.totalSecs).toBe(900);
  });

  it('labels each month once and never labels the neighbouring December', () => {
    const grid = buildHeatmapYear(2026, new Map());
    const labels = grid.weeks.map((week) => week.monthLabel).filter(Boolean);

    expect(labels).toHaveLength(12);
    // 2026-01-01 is a Thursday, so week 0 starts on 2025-12-29: the label must
    // come from the first day *in* the year, not from the column's Monday.
    // Compare against dayjs itself: `initDayjs(settings.locale)` sets the global
    // dayjs locale at runtime, so a hard-coded 'Jan' fails as soon as the suite
    // runs under another language.
    expect(labels[0]).toBe(dayjs('2026-01-01').format('MMM'));
    expect(grid.weeks[0]!.cells.some((cell) => !cell.inYear)).toBe(true);
  });

  it('returns an empty calendar for a year with no data', () => {
    const grid = buildHeatmapYear(2020, new Map());
    expect(grid.totalSecs).toBe(0);
    expect(inYearCells(grid).every((cell) => cell.secs === 0)).toBe(true);
  });
});

/**
 * A year is 53 ISO columns, which never fit a phone width, so the calendar is
 * stacked as two half-year rows. The split must keep every column exactly once
 * and break at the July boundary — splitting a month in half would strand its
 * label on the wrong row.
 */
describe('splitWeeksIntoRows', () => {
  it('splits a year into two rows at the first July column', () => {
    const grid = buildHeatmapYear(2026, new Map());
    const rows = splitWeeksIntoRows(grid.weeks);

    expect(rows).toHaveLength(2);
    expect(rows.flat().map((week) => week.index)).toEqual(grid.weeks.map((week) => week.index));

    const firstDayOf = (row: typeof grid.weeks) => row[0]!.cells.find((cell) => cell.inYear)!.date;
    expect(firstDayOf(rows[0]!).month()).toBe(0);
    expect(firstDayOf(rows[1]!).month()).toBe(5);
    // The second row's opening column is the week that carries July 1.
    expect(rows[1]![0]!.cells.some((cell) => cell.inYear && cell.date.date() === 1)).toBe(true);
  });

  it('leaves a partial-year grid on a single row', () => {
    const grid = buildHeatmapYear(2026, new Map());
    const single = grid.weeks.slice(0, 20);
    expect(splitWeeksIntoRows(single)).toEqual([single]);
  });
});

/**
 * The legend has five steps and no numbers, so the bucket boundaries are the
 * only contract: a day that reads "15 minutes" in the tooltip must not be
 * painted with the second-step tint.
 */
describe('bucketClass', () => {
  const EMPTY = 'bg-base-300/70';

  it('keeps the maximum inclusive at every step', () => {
    expect(bucketClass(0)).toBe(EMPTY);
    expect(bucketClass(1)).toBe('bg-primary/25');
    expect(bucketClass(15 * 60)).toBe('bg-primary/25');
    expect(bucketClass(15 * 60 + 1)).toBe('bg-primary/45');
    expect(bucketClass(30 * 60)).toBe('bg-primary/45');
    expect(bucketClass(60 * 60)).toBe('bg-primary/65');
    expect(bucketClass(120 * 60)).toBe('bg-primary/85');
    expect(bucketClass(120 * 60 + 1)).toBe('bg-primary');
  });
});
