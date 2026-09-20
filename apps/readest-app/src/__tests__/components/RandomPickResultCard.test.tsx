import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

import RandomPickResultCard from '@/app/library/components/randompick/RandomPickResultCard';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { Book } from '@/types/book';
import { SystemSettings } from '@/types/settings';

const makeBook = (overrides: Partial<Book> = {}): Book =>
  ({
    hash: 'abc',
    title: 'Dune',
    author: 'Frank Herbert',
    format: 'EPUB',
    groupName: '科幻小说',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Book;

beforeEach(() => {
  useLibraryStore.setState({ coverThumbnails: new Map(), library: [], hashIndex: new Map() });
  useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
});

afterEach(cleanup);

describe('RandomPickResultCard', () => {
  it('shows the title, author, group and format', () => {
    render(
      <RandomPickResultCard book={makeBook()} onStartReading={vi.fn()} onSpinAgain={vi.fn()} />,
    );
    // 标题与作者在封面文字兜底里也会出现一次，因此按数量断言
    expect(screen.getAllByText('Dune').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Frank Herbert').length).toBeGreaterThan(0);
    expect(screen.getByText(/科幻小说/)).toBeTruthy();
    expect(screen.getByText(/EPUB/)).toBeTruthy();
  });

  it('labels a book without reading status as unread', () => {
    render(
      <RandomPickResultCard book={makeBook()} onStartReading={vi.fn()} onSpinAgain={vi.fn()} />,
    );
    expect(screen.getByText(/Unread/)).toBeTruthy();
  });

  it('labels a finished book and shows the progress percentage', () => {
    render(
      <RandomPickResultCard
        book={makeBook({ readingStatus: 'finished', progress: [90, 120] })}
        onStartReading={vi.fn()}
        onSpinAgain={vi.fn()}
      />,
    );
    expect(screen.getByText(/Finished/)).toBeTruthy();
    expect(screen.getByText(/75% read/)).toBeTruthy();
  });

  it('omits the progress segment when the total page count is zero', () => {
    render(
      <RandomPickResultCard
        book={makeBook({ progress: [0, 0] })}
        onStartReading={vi.fn()}
        onSpinAgain={vi.fn()}
      />,
    );
    expect(screen.queryByText(/% read/)).toBeNull();
  });

  it('calls onStartReading when the primary action is pressed', () => {
    const onStartReading = vi.fn();
    render(
      <RandomPickResultCard
        book={makeBook()}
        onStartReading={onStartReading}
        onSpinAgain={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Start Reading'));
    expect(onStartReading).toHaveBeenCalledTimes(1);
  });

  it('calls onSpinAgain when the secondary action is pressed', () => {
    const onSpinAgain = vi.fn();
    render(
      <RandomPickResultCard book={makeBook()} onStartReading={vi.fn()} onSpinAgain={onSpinAgain} />,
    );
    fireEvent.click(screen.getByText('Spin Again'));
    expect(onSpinAgain).toHaveBeenCalledTimes(1);
  });
});
