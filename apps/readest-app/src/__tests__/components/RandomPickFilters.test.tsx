import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    // biome-ignore lint/a11y/useAltText: test mock; alt comes from spread props
    return <img {...props} />;
  },
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: null }),
}));

vi.mock('@/services/environment', () => ({
  getInitializedAppService: () => null,
  isTauriAppPlatform: () => false,
}));

import RandomPickFilters from '@/app/library/components/randompick/RandomPickFilters';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { Book } from '@/types/book';
import { RandomPickRules, SystemSettings } from '@/types/settings';

const makeBook = (overrides: Partial<Book> & { hash: string }): Book =>
  ({
    title: `Book ${overrides.hash}`,
    author: 'Author',
    format: 'EPUB',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Book;

const makeRules = (overrides: Partial<RandomPickRules> = {}): RandomPickRules => ({
  includeGroups: [],
  excludeGroups: [],
  excludeBooks: [],
  avoidRepeats: true,
  skipAnimation: false,
  ...overrides,
});

const books = [
  makeBook({ hash: 'a', title: 'Dune', groupName: '科幻小说' }),
  makeBook({ hash: 'b', title: 'Cosmos', groupName: '科学' }),
];

beforeEach(() => {
  useLibraryStore.setState({
    groups: { 'id-sci-fi': '科幻小说', 'id-fiction': '科幻小说/短篇', 'id-science': '科学' },
  });
  useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
});

afterEach(cleanup);

const renderFilters = (rules = makeRules(), onChange = vi.fn(), onRestoreDefaults = vi.fn()) => {
  const view = render(
    <RandomPickFilters
      rules={rules}
      books={books}
      groupCounts={
        new Map([
          ['科幻小说', 1],
          ['科幻小说/短篇', 0],
          ['科学', 1],
        ])
      }
      pool={{ pool: books, total: 2, excluded: 0 }}
      onChange={onChange}
      onRestoreDefaults={onRestoreDefaults}
    />,
  );
  return { ...view, onChange, onRestoreDefaults };
};

describe('RandomPickFilters', () => {
  it('reports the candidate pool size', () => {
    const { container } = render(
      <RandomPickFilters
        rules={makeRules()}
        books={books}
        groupCounts={new Map()}
        pool={{ pool: [books[0]!], total: 5, excluded: 4 }}
        onChange={vi.fn()}
        onRestoreDefaults={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('Candidate Pool');
    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('5');
  });

  it('adds a picked group to the include list', () => {
    const { onChange } = renderFilters();
    fireEvent.click(screen.getAllByText('Add Group')[0]!);
    fireEvent.click(screen.getByText('科幻小说'));
    expect(onChange).toHaveBeenCalledWith({ includeGroups: ['科幻小说'] });
  });

  it('adds a picked group to the exclude list', () => {
    const { onChange } = renderFilters();
    fireEvent.click(screen.getAllByText('Add Group')[1]!);
    fireEvent.click(screen.getByText('科幻小说'));
    expect(onChange).toHaveBeenCalledWith({ excludeGroups: ['科幻小说'] });
  });

  it('does not duplicate an already included group', () => {
    const { onChange } = renderFilters(makeRules({ includeGroups: ['科学'] }));
    fireEvent.click(screen.getAllByText('Add Group')[0]!);
    // 已被选中的分组同时出现在 chip 与选择器里，按 test id 定位选择器那一行
    const scienceRow = screen
      .getAllByTestId('group-row')
      .find((row) => row.textContent?.includes('科学'))!;
    fireEvent.click(scienceRow);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes an included group', () => {
    const { onChange } = renderFilters(makeRules({ includeGroups: ['科学', '科幻小说'] }));
    fireEvent.click(screen.getByLabelText('Remove 科学'));
    expect(onChange).toHaveBeenCalledWith({ includeGroups: ['科幻小说'] });
  });

  it('toggles a book into the exclusion list from the searchable picker', () => {
    const { onChange } = renderFilters();
    fireEvent.click(screen.getByText('Search and exclude books'));
    fireEvent.change(screen.getByPlaceholderText('Search Books...'), {
      target: { value: 'dune' },
    });
    fireEvent.click(screen.getByText('Dune'));
    expect(onChange).toHaveBeenCalledWith({ excludeBooks: ['a'] });
  });

  it('toggles an already excluded book back out', () => {
    const { onChange } = renderFilters(makeRules({ excludeBooks: ['a'] }));
    fireEvent.click(screen.getByText('Search and exclude books'));
    // 书名同时出现在「已排除」列表与搜索结果里，按 test id 定位搜索那一行
    const duneOption = screen
      .getAllByTestId('book-option')
      .find((row) => row.textContent?.includes('Dune'))!;
    fireEvent.click(duneOption);
    expect(onChange).toHaveBeenCalledWith({ excludeBooks: [] });
  });

  it('flips the avoid-repeats switch', () => {
    const { onChange } = renderFilters();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Avoid repeats in this session' }));
    expect(onChange).toHaveBeenCalledWith({ avoidRepeats: false });
  });

  it('flips the skip-animation switch', () => {
    const { onChange } = renderFilters(makeRules({ skipAnimation: false }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Skip Animation' }));
    expect(onChange).toHaveBeenCalledWith({ skipAnimation: true });
  });

  it('asks the parent to restore defaults', () => {
    const { onRestoreDefaults } = renderFilters();
    fireEvent.click(screen.getByText('Restore Defaults'));
    expect(onRestoreDefaults).toHaveBeenCalledTimes(1);
  });
});
