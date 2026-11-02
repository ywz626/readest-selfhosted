import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ReadingHeatmap from '@/app/stats/components/ReadingHeatmap';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string, p?: Record<string, unknown>) =>
    p ? s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(p[k] ?? '')) : s,
}));
vi.mock('@/utils/misc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/misc')>()),
  getLocale: () => 'en-US',
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const readDay = (date: string, minutes: number) => {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year!, month: month!, day: day!, durationSecs: minutes * 60 };
};

const dateOf = (element: Element | null) => (element as HTMLElement | null)?.dataset['date'];

describe('ReadingHeatmap keyboard access', () => {
  it('keeps one tab stop for the whole year and steps days with the arrow keys', () => {
    vi.useFakeTimers({ now: new Date('2026-10-21T12:00:00'), toFake: ['Date'] });
    const { container } = render(
      <ReadingHeatmap daily={[readDay('2026-10-22', 30)]} year={2026} onSelectDay={() => {}} />,
    );

    // Every in-year day is clickable, but only one of them is in the tab order.
    expect(container.querySelectorAll('button[data-date]')).toHaveLength(365);
    const tabStops = container.querySelectorAll('button[data-date][tabindex="0"]');
    expect(tabStops).toHaveLength(1);
    expect(dateOf(tabStops[0]!)).toBe('2026-10-21');

    fireEvent.focus(tabStops[0]!);
    expect(screen.getByRole('status').textContent).toContain('Oct 21');

    fireEvent.keyDown(tabStops[0]!, { key: 'ArrowDown' });
    expect(dateOf(document.activeElement)).toBe('2026-10-22');
    expect(screen.getByRole('status').textContent).toContain('30 min');

    // A week left is the same weekday in the previous column.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(dateOf(document.activeElement)).toBe('2026-10-15');
  });

  it('does not step outside the rendered year', () => {
    vi.useFakeTimers({ now: new Date('2026-01-02T12:00:00'), toFake: ['Date'] });
    const { container } = render(<ReadingHeatmap daily={[]} year={2026} onSelectDay={() => {}} />);
    const tabStop = container.querySelector<HTMLElement>('button[data-date][tabindex="0"]')!;

    fireEvent.focus(tabStop);
    fireEvent.keyDown(tabStop, { key: 'ArrowUp' });
    expect(dateOf(document.activeElement)).toBe('2026-01-01');

    // The day above Jan 1 is 2025-12-31, which the 2026 grid does not render.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(dateOf(document.activeElement)).toBe('2026-01-01');
  });
});

describe('ReadingHeatmap drill-down', () => {
  it('reports the clicked day so the page can re-scope the ranking', () => {
    const onSelectDay = vi.fn();
    const { container } = render(
      <ReadingHeatmap daily={[]} year={2026} onSelectDay={onSelectDay} />,
    );

    fireEvent.click(container.querySelector('button[data-date="2026-03-09"]')!);

    expect(onSelectDay).toHaveBeenCalledTimes(1);
    expect(onSelectDay.mock.calls[0]![0].format('YYYY-MM-DD')).toBe('2026-03-09');
  });
});

describe('ReadingHeatmap responsive rows', () => {
  /** jsdom's matchMedia stub always answers `matches: false`; steer it per test. */
  const setViewport = (compact: boolean) => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: compact && query.includes('max-width'),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stacks two half-year rows on a phone', () => {
    setViewport(true);
    const { container } = render(<ReadingHeatmap daily={[]} year={2026} onSelectDay={() => {}} />);

    const rows = container.querySelectorAll('[data-heatmap-row]');
    expect(rows).toHaveLength(2);
    // 2026-07-01 is a Wednesday, so the column carrying it starts on Jun 29 and
    // opens the second row.
    expect(rows[0]!.querySelector('button[data-date="2026-06-28"]')).not.toBeNull();
    expect(rows[0]!.querySelector('button[data-date="2026-06-29"]')).toBeNull();
    expect(rows[1]!.querySelector('button[data-date="2026-06-29"]')).not.toBeNull();
    expect(rows[1]!.querySelector('button[data-date="2026-07-06"]')).not.toBeNull();
  });

  it('keeps the year on a single row where the width allows it', () => {
    setViewport(false);
    const { container } = render(<ReadingHeatmap daily={[]} year={2026} onSelectDay={() => {}} />);

    const rows = container.querySelectorAll('[data-heatmap-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('button[data-date="2026-06-28"]')).not.toBeNull();
    expect(rows[0]!.querySelector('button[data-date="2026-07-06"]')).not.toBeNull();
  });
});
