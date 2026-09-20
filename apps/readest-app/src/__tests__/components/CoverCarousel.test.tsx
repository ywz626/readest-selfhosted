import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    // biome-ignore lint/a11y/useAltText: test mock; alt comes from spread props
    return <img {...props} />;
  },
}));

vi.mock('@/services/environment', () => ({
  getInitializedAppService: () => null,
  isTauriAppPlatform: () => false,
}));

import CoverCarousel from '@/app/library/components/randompick/CoverCarousel';
import { buildCarouselTrack } from '@/app/library/utils/randomPickUtils';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { Book } from '@/types/book';
import { SystemSettings } from '@/types/settings';

const makeBook = (hash: string): Book =>
  ({
    hash,
    title: `Book ${hash}`,
    author: 'Author',
    format: 'EPUB',
    createdAt: 0,
    updatedAt: 0,
  }) as Book;

const pool = ['a', 'b', 'c', 'd'].map(makeBook);
const track = buildCarouselTrack(pool, pool[2]!, () => 0.5, 6);

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useLibraryStore.setState({ coverThumbnails: new Map(), library: [], hashIndex: new Map() });
  useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CoverCarousel', () => {
  it('renders one cover per track slot', () => {
    const { container } = render(
      <CoverCarousel track={track} spinning={false} skipAnimation={false} onSettled={vi.fn()} />,
    );
    expect(container.querySelectorAll('.book-cover-container')).toHaveLength(track.books.length);
  });

  it('renders the target title so the settled cover is identifiable', () => {
    render(
      <CoverCarousel track={track} spinning={false} skipAnimation={false} onSettled={vi.fn()} />,
    );
    expect(
      screen.getAllByText(`Book ${track.books[track.targetIndex]!.hash}`).length,
    ).toBeGreaterThan(0);
  });

  it('settles synchronously when the animation is skipped', () => {
    const onSettled = vi.fn();
    render(<CoverCarousel track={track} spinning skipAnimation onSettled={onSettled} />);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('settles through the fallback timer when the transition never fires', () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    render(<CoverCarousel track={track} spinning skipAnimation={false} onSettled={onSettled} />);
    expect(onSettled).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('starts each spin from the beginning of the track', () => {
    const onSettled = vi.fn();
    const { container, rerender } = render(
      <CoverCarousel track={track} spinning={false} skipAnimation={false} onSettled={onSettled} />,
    );
    const styleOf = () => container.querySelector('.will-change-transform')!.getAttribute('style')!;

    // 空闲时停在轨道起点，这样点「开始随机」才有整条轨道可以滚
    expect(styleOf()).toContain('translate3d(0px');
    expect(styleOf()).toContain('transform 0ms');

    // 开抽后位移到目标位，并带上完整的过渡时长
    rerender(<CoverCarousel track={track} spinning skipAnimation={false} onSettled={onSettled} />);
    expect(styleOf()).not.toContain('translate3d(0px');
    expect(styleOf()).toContain('transform 2200ms');
  });

  it('does not settle twice when the transition and the timer both fire', () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const { container } = render(
      <CoverCarousel track={track} spinning skipAnimation={false} onSettled={onSettled} />,
    );
    const rail = container.querySelector('.will-change-transform')!;
    // jsdom 没有 TransitionEvent，手工挂上 propertyName，否则 handleTransitionEnd
    // 会因为属性名不匹配而提前返回，用例就测不到「重复结算」这条路径。
    const transitionEnd = new Event('transitionend', { bubbles: true });
    Object.defineProperty(transitionEnd, 'propertyName', { value: 'transform' });
    act(() => {
      rail.dispatchEvent(transitionEnd);
      vi.advanceTimersByTime(2500);
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
