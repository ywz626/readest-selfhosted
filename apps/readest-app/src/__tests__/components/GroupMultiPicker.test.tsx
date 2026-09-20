import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: null }),
}));

import GroupMultiPicker from '@/app/library/components/randompick/GroupMultiPicker';
import { useLibraryStore } from '@/store/libraryStore';

const GROUP_IDS = {
  literature: 'id-literature',
  fiction: 'id-fiction',
  poetry: 'id-poetry',
  tech: 'id-tech',
};

beforeEach(() => {
  useLibraryStore.setState({
    groups: {
      [GROUP_IDS.literature]: '文学',
      [GROUP_IDS.fiction]: '文学/小说',
      [GROUP_IDS.poetry]: '文学/诗集',
      [GROUP_IDS.tech]: '技术',
    },
  });
});

afterEach(cleanup);

const counts = new Map<string, number>([
  ['文学', 3],
  ['文学/小说', 1],
  ['文学/诗集', 2],
  ['技术', 5],
]);

describe('GroupMultiPicker', () => {
  it('lists only the top level groups and their book counts', () => {
    render(
      <GroupMultiPicker
        selectedGroups={[]}
        groupCounts={counts}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('文学')).toBeTruthy();
    expect(screen.getByText('技术')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    // 子分组不在顶层列出
    expect(screen.queryByText('小说')).toBeNull();
  });

  it('reports the full path of the picked group', () => {
    const onSelect = vi.fn();
    render(
      <GroupMultiPicker
        selectedGroups={[]}
        groupCounts={counts}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('技术'));
    expect(onSelect).toHaveBeenCalledWith('技术');
  });

  it('navigates into a child group and back through the breadcrumb', () => {
    render(
      <GroupMultiPicker
        selectedGroups={[]}
        groupCounts={counts}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByTestId('group-enter')[0]!);
    expect(screen.getByText('小说')).toBeTruthy();
    expect(screen.getByText('诗集')).toBeTruthy();

    fireEvent.click(screen.getByText('All Books'));
    expect(screen.queryByText('小说')).toBeNull();
    expect(screen.getByText('文学')).toBeTruthy();
  });

  it('picking a nested group reports the nested full path', () => {
    const onSelect = vi.fn();
    render(
      <GroupMultiPicker
        selectedGroups={[]}
        groupCounts={counts}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByTestId('group-enter')[0]!);
    fireEvent.click(screen.getByText('小说'));
    expect(onSelect).toHaveBeenCalledWith('文学/小说');
  });

  it('marks already selected groups with a check', () => {
    const { container } = render(
      <GroupMultiPicker
        selectedGroups={['技术']}
        groupCounts={counts}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('[data-testid="group-selected"]')).toHaveLength(1);
  });

  it('shows an empty hint when there are no groups', () => {
    useLibraryStore.setState({ groups: {} });
    render(
      <GroupMultiPicker
        selectedGroups={[]}
        groupCounts={new Map()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('No Groups')).toBeTruthy();
  });

  it('closes when cancel is pressed', () => {
    const onClose = vi.fn();
    render(
      <GroupMultiPicker
        selectedGroups={[]}
        groupCounts={counts}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
