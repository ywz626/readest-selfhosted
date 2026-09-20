import React, { useMemo, useState } from 'react';
import { IoMdCloseCircle } from 'react-icons/io';
import { MdCheck } from 'react-icons/md';
import { PiPlus } from 'react-icons/pi';

import { useTranslation } from '@/hooks/useTranslation';
import { Book } from '@/types/book';
import { RandomPickRules } from '@/types/settings';
import { formatAuthors, formatTitle } from '@/utils/book';
import { createBookFilter } from '../../utils/libraryUtils';
import { CandidatePool } from '../../utils/randomPickUtils';
import GroupMultiPicker from './GroupMultiPicker';

/** 「排除的书籍」搜索结果上限，避免一次渲染整库 */
const MAX_BOOK_RESULTS = 50;

type GroupPickerTarget = 'include' | 'exclude';

interface RandomPickFiltersProps {
  rules: RandomPickRules;
  /** 用于「排除的书籍」搜索的候选书籍，应传 visibleLibrary */
  books: readonly Book[];
  /** 每个分组（含祖先路径）的书目数 */
  groupCounts: ReadonlyMap<string, number>;
  /** 当前候选池统计 */
  pool: CandidatePool;
  onChange: (patch: Partial<RandomPickRules>) => void;
  onRestoreDefaults: () => void;
}

const RandomPickFilters: React.FC<RandomPickFiltersProps> = ({
  rules,
  books,
  groupCounts,
  pool,
  onChange,
  onRestoreDefaults,
}) => {
  const _ = useTranslation();
  const [pickerTarget, setPickerTarget] = useState<GroupPickerTarget | null>(null);
  const [showBookPicker, setShowBookPicker] = useState(false);
  const [bookQuery, setBookQuery] = useState('');

  const excludedBookHashes = useMemo(() => new Set(rules.excludeBooks), [rules.excludeBooks]);

  const matchedBooks = useMemo(() => {
    const filter = createBookFilter(bookQuery.trim() || null);
    return books
      .filter((book) => filter(book))
      .sort((a, b) => formatTitle(a.title).localeCompare(formatTitle(b.title)))
      .slice(0, MAX_BOOK_RESULTS);
  }, [books, bookQuery]);

  const addGroup = (target: GroupPickerTarget, name: string) => {
    if (target === 'include') {
      if (rules.includeGroups.includes(name)) return;
      onChange({ includeGroups: [...rules.includeGroups, name] });
      return;
    }
    if (rules.excludeGroups.includes(name)) return;
    onChange({ excludeGroups: [...rules.excludeGroups, name] });
  };

  const removeGroup = (target: GroupPickerTarget, name: string) => {
    if (target === 'include') {
      onChange({ includeGroups: rules.includeGroups.filter((item) => item !== name) });
      return;
    }
    onChange({ excludeGroups: rules.excludeGroups.filter((item) => item !== name) });
  };

  const toggleBook = (hash: string) => {
    const next = excludedBookHashes.has(hash)
      ? rules.excludeBooks.filter((item) => item !== hash)
      : [...rules.excludeBooks, hash];
    onChange({ excludeBooks: next });
  };

  const poolSummary =
    pool.excluded > 0
      ? _('Candidate Pool: {{available}} of {{total}} · {{excluded}} excluded', {
          available: pool.pool.length,
          total: pool.total,
          excluded: pool.excluded,
        })
      : _('Candidate Pool: {{available}} of {{total}}', {
          available: pool.pool.length,
          total: pool.total,
        });

  const groupSection = (target: GroupPickerTarget, title: string, paths: string[]) => (
    <div className='space-y-1.5'>
      <p className='text-base-content/50 text-xs'>{title}</p>
      <div className='flex flex-wrap items-center gap-1'>
        {paths.map((path) => (
          <span
            key={path}
            className='bg-base-300/70 flex items-center gap-1 rounded-full px-2 py-0.5 text-xs'
          >
            <span className='max-w-32 truncate'>{path}</span>
            <button
              type='button'
              aria-label={`${_('Remove')} ${path}`}
              onClick={() => removeGroup(target, path)}
            >
              <IoMdCloseCircle className='h-3.5 w-3.5' />
            </button>
          </span>
        ))}
        <button
          type='button'
          onClick={() => {
            setShowBookPicker(false);
            setPickerTarget(pickerTarget === target ? null : target);
          }}
          className='text-base-content/60 hover:text-base-content flex items-center gap-1 rounded-full border border-dashed border-current px-2 py-0.5 text-xs'
        >
          <PiPlus className='h-3 w-3' />
          <span>{_('Add Group')}</span>
        </button>
      </div>
      {pickerTarget === target && (
        <div className='border-base-300 rounded-md border p-1'>
          <GroupMultiPicker
            selectedGroups={paths}
            groupCounts={groupCounts}
            onSelect={(name) => {
              addGroup(target, name);
              // 选择器是单选语义，选完即收起，避免用户误以为还要再点一次确认
              setPickerTarget(null);
            }}
            onClose={() => setPickerTarget(null)}
          />
        </div>
      )}
    </div>
  );

  return (
    <div className='space-y-4'>
      {groupSection('include', _('Only pick from these groups'), rules.includeGroups)}
      {groupSection('exclude', _('Exclude these groups'), rules.excludeGroups)}

      <div className='space-y-1.5'>
        <p className='text-base-content/50 text-xs'>{_('Excluded Books')}</p>
        <ul className='space-y-0.5'>
          {rules.excludeBooks.map((hash) => (
            <li key={hash} className='text-base-content/70 flex items-center gap-1 text-xs'>
              <span className='min-w-0 flex-1 truncate'>
                {formatTitle(books.find((book) => book.hash === hash)?.title ?? hash)}
              </span>
              <button
                type='button'
                aria-label={`${_('Remove')} ${hash}`}
                onClick={() => toggleBook(hash)}
              >
                <IoMdCloseCircle className='h-3.5 w-3.5' />
              </button>
            </li>
          ))}
        </ul>
        <button
          type='button'
          onClick={() => {
            setPickerTarget(null);
            setShowBookPicker((prev) => !prev);
          }}
          className='text-base-content/60 hover:text-base-content flex items-center gap-1 rounded-full border border-dashed border-current px-2 py-0.5 text-xs'
        >
          <PiPlus className='h-3 w-3' />
          <span>{_('Search and exclude books')}</span>
        </button>
        {showBookPicker && (
          <div className='border-base-300 rounded-md border p-1'>
            <input
              type='search'
              value={bookQuery}
              onChange={(event) => setBookQuery(event.target.value)}
              placeholder={_('Search Books...')}
              className='input input-ghost h-8 min-h-8 w-full text-sm'
            />
            <ul className='max-h-56 overflow-y-auto'>
              {matchedBooks.map((book) => (
                <li key={book.hash}>
                  <button
                    type='button'
                    data-testid='book-option'
                    onClick={() => toggleBook(book.hash)}
                    className='hover:bg-base-300 flex w-full items-center gap-2 rounded-md px-2 py-1.5'
                  >
                    <span className='min-w-0 flex-1 truncate text-start text-sm'>
                      {formatTitle(book.title)}
                    </span>
                    <span className='text-base-content/40 shrink-0 text-xs'>
                      {formatAuthors(book.author)}
                    </span>
                    {excludedBookHashes.has(book.hash) && (
                      <MdCheck className='h-4 w-4 shrink-0 fill-blue-500' />
                    )}
                  </button>
                </li>
              ))}
              {matchedBooks.length === 0 && (
                <li className='text-base-content/40 px-2 py-4 text-center text-sm'>
                  {_('No books match')}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>

      <div className='border-base-300 space-y-2 border-t pt-3'>
        <label className='flex items-center gap-2'>
          <input
            type='checkbox'
            aria-label={_('Avoid repeats in this session')}
            checked={rules.avoidRepeats}
            onChange={(event) => onChange({ avoidRepeats: event.target.checked })}
          />
          <span className='text-sm'>{_('Avoid repeats in this session')}</span>
        </label>
        <label className='flex items-center gap-2'>
          <input
            type='checkbox'
            aria-label={_('Skip Animation')}
            checked={rules.skipAnimation}
            onChange={(event) => onChange({ skipAnimation: event.target.checked })}
          />
          <span className='text-sm'>{_('Skip Animation')}</span>
        </label>
      </div>

      <div className='border-base-300 flex items-center justify-between border-t pt-3'>
        <span className='text-base-content/60 text-xs'>{poolSummary}</span>
        <button type='button' onClick={onRestoreDefaults} className='text-xs text-blue-500'>
          {_('Restore Defaults')}
        </button>
      </div>
    </div>
  );
};

export default RandomPickFilters;
