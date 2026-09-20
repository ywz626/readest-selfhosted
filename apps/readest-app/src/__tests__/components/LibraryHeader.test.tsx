import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isMobile: false, hasWindowBar: false } }),
}));
vi.mock('@/hooks/useTrafficLight', () => ({
  useTrafficLight: () => ({ isTrafficLightVisible: false }),
}));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: () => 16 }));
vi.mock('@/hooks/useShortcuts', () => ({ default: () => {} }));
// 这几个子菜单会把 settings / reader 一大串依赖拖进来，本用例只关心入口按钮，
// 因此把它们替换成空实现，让断言聚焦在按钮本身。
vi.mock('@/app/library/components/ImportMenu', () => ({ default: () => null }));
vi.mock('@/app/library/components/SettingsMenu', () => ({ default: () => null }));
vi.mock('@/app/library/components/ViewMenu', () => ({ default: () => null }));
vi.mock('@/components/WindowButtons', () => ({ default: () => null }));

import LibraryHeader from '@/app/library/components/LibraryHeader';
import { useLibraryStore } from '@/store/libraryStore';
import { useThemeStore } from '@/store/themeStore';
import { LibrarySearchConfig } from '@/types/book';

beforeEach(() => {
  useLibraryStore.setState({ currentBookshelf: [] });
  useThemeStore.setState({
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    systemUIVisible: false,
    statusBarHeight: 0,
  });
});

afterEach(cleanup);

const renderHeader = (onOpenRandomPick = vi.fn()) => {
  render(
    <LibraryHeader
      isSelectMode={false}
      isSelectAll={false}
      onPullLibrary={vi.fn()}
      onImportBooksFromFiles={vi.fn()}
      onOpenCatalogManager={vi.fn()}
      onOpenFeeds={vi.fn()}
      onToggleSelectMode={vi.fn()}
      onSelectAll={vi.fn()}
      onDeselectAll={vi.fn()}
      searchQuery=''
      searchTarget='books'
      searchConfig={{} as LibrarySearchConfig}
      onSearchConfigChange={vi.fn()}
      onSearchQueryChange={vi.fn()}
      onSearchTargetChange={vi.fn()}
      onOpenRandomPick={onOpenRandomPick}
    />,
  );
  return onOpenRandomPick;
};

describe('LibraryHeader random pick entry', () => {
  it('renders the random pick button', () => {
    renderHeader();
    expect(screen.getByLabelText('Random Pick')).toBeTruthy();
  });

  it('opens the random pick dialog when pressed', () => {
    const onOpenRandomPick = renderHeader();
    fireEvent.click(screen.getByLabelText('Random Pick'));
    expect(onOpenRandomPick).toHaveBeenCalledTimes(1);
  });
});
