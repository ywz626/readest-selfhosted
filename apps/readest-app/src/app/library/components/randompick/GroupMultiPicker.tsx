import React, { useMemo, useState } from 'react';
import { HiOutlineFolder } from 'react-icons/hi';
import { MdCheck, MdChevronRight } from 'react-icons/md';

import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { getBreadcrumbs } from '../../utils/libraryUtils';

interface GroupMultiPickerProps {
  /** 当前列表中已选中的分组全路径，用于打勾 */
  selectedGroups: readonly string[];
  /** 每个分组（含祖先路径）的书目数 */
  groupCounts: ReadonlyMap<string, number>;
  /** 选中一个分组，路径为全路径（如 `文学/小说`） */
  onSelect: (groupName: string) => void;
  onClose: () => void;
}

/**
 * 「选择一个分组」的层级单选器。由 RandomPickFilters 以浮层形式打开，
 * 调用方决定把结果放进白名单还是黑名单。
 *
 * 刻意不与 GroupingModal 抽取公共组件：那个组件同时承担建组、重命名、
 * 移出分组，语义不同，硬抽公共部分的耦合成本高于这里的导航逻辑重复。
 */
const GroupMultiPicker: React.FC<GroupMultiPickerProps> = ({
  selectedGroups,
  groupCounts,
  onSelect,
  onClose,
}) => {
  const _ = useTranslation();
  const groups = useLibraryStore((state) => state.groups);
  const getGroupsByParent = useLibraryStore((state) => state.getGroupsByParent);
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined);

  // `groups` 变化时必须重算：getGroupsByParent 读的是 store 里的最新快照。
  const currentGroups = useMemo(
    () => [...getGroupsByParent(currentPath)].sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentPath, groups, getGroupsByParent],
  );

  const allGroupNames = useMemo(() => Object.values(groups), [groups]);
  const hasChildren = (name: string) => allGroupNames.some((other) => other.startsWith(`${name}/`));
  const labelOf = (name: string) => name.split('/').pop() ?? name;

  return (
    <div className='flex max-h-[60vh] flex-col'>
      <div className='flex flex-wrap items-center gap-1 px-2 py-1'>
        <button
          type='button'
          onClick={() => setCurrentPath(undefined)}
          className='hover:bg-base-300 rounded-sm px-2 py-1 text-sm'
        >
          {_('All Books')}
        </button>
        {currentPath &&
          getBreadcrumbs(currentPath).map((crumb, index, array) => (
            <React.Fragment key={crumb.path}>
              <MdChevronRight className='text-base-content/50 h-4 w-4' />
              {index === array.length - 1 ? (
                <span className='truncate px-2 py-1 text-sm'>{crumb.name}</span>
              ) : (
                <button
                  type='button'
                  onClick={() => setCurrentPath(crumb.path)}
                  className='hover:bg-base-300 truncate rounded-sm px-2 py-1 text-sm'
                >
                  {crumb.name}
                </button>
              )}
            </React.Fragment>
          ))}
      </div>

      <ul className='min-h-0 flex-1 overflow-y-auto'>
        {currentGroups.length === 0 && (
          <li className='text-base-content/50 px-3 py-6 text-center text-sm'>{_('No Groups')}</li>
        )}
        {currentGroups.map((group) => (
          <li key={group.id} className='flex items-center gap-1 px-1'>
            <button
              type='button'
              data-testid='group-row'
              onClick={() => onSelect(group.name)}
              className='hover:bg-base-300 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2'
            >
              <HiOutlineFolder className='h-4 w-4 shrink-0' />
              <span className='min-w-0 flex-1 truncate text-start text-sm'>
                {labelOf(group.name)}
              </span>
              <span className='text-base-content/50 shrink-0 text-xs'>
                {groupCounts.get(group.name) ?? 0}
              </span>
              {selectedGroups.includes(group.name) && (
                <MdCheck data-testid='group-selected' className='h-4 w-4 shrink-0 fill-blue-500' />
              )}
            </button>
            {hasChildren(group.name) && (
              <button
                type='button'
                data-testid='group-enter'
                aria-label={`${_('Open Folder')} ${labelOf(group.name)}`}
                onClick={() => setCurrentPath(group.name)}
                className='hover:bg-base-300 shrink-0 rounded-md px-1 py-2'
              >
                <MdChevronRight className='h-4 w-4' />
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className='mt-2 flex justify-end px-2'>
        <button type='button' onClick={onClose} className='px-2 py-1 text-sm'>
          {_('Cancel')}
        </button>
      </div>
    </div>
  );
};

export default GroupMultiPicker;
