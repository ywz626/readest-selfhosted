import clsx from 'clsx';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IoMdCloseCircle } from 'react-icons/io';

import { useEnv } from '@/context/EnvContext';
import { useKeyDownActions } from '@/hooks/useKeyDownActions';
import { useTranslation } from '@/hooks/useTranslation';
import { DEFAULT_RANDOM_PICK_RULES } from '@/services/constants';
import { useLibraryStore } from '@/store/libraryStore';
import { useRandomPickStore } from '@/store/randomPickStore';
import { useSettingsStore } from '@/store/settingsStore';
import { Book } from '@/types/book';
import { RandomPickRules } from '@/types/settings';
import { debounce } from '@/utils/debounce';
import {
  buildCandidatePool,
  buildCarouselTrack,
  buildGroupCounts,
  CarouselTrack,
  EMPTY_HASH_SET,
  normalizeRandomPickRules,
  pickRandomBook,
} from '../../utils/randomPickUtils';
import CoverCarousel from './CoverCarousel';
import RandomPickFilters from './RandomPickFilters';
import RandomPickResultCard from './RandomPickResultCard';

interface RandomPickDialogProps {
  onClose: () => void;
  onOpenBook: (book: Book) => void;
}

/** 规则变更写盘的防抖窗口 */
const RULES_PERSIST_DELAY_MS = 300;

const RandomPickDialog: React.FC<RandomPickDialogProps> = ({ onClose, onOpenBook }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const visibleLibrary = useLibraryStore((state) => state.visibleLibrary);
  const settings = useSettingsStore((state) => state.settings);
  const { pickedHashes, isSpinning, pickCount, markPicked, setSpinning, resetPicked } =
    useRandomPickStore();

  const [rules, setRules] = useState<RandomPickRules>(() =>
    normalizeRandomPickRules(settings.randomPickRules),
  );
  const [track, setTrack] = useState<CarouselTrack | null>(null);
  const [pendingTarget, setPendingTarget] = useState<Book | null>(null);
  const [result, setResult] = useState<Book | null>(null);
  const [skipRequested, setSkipRequested] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 移动端把筛选面板收成可展开抽屉：面板本身在手机上要占满一屏以上，
   * 展开状态下「开始随机」按钮会被推到屏幕外，抽中后结果也落在视口之外。
   * 桌面端（sm 及以上）始终展开，这个开关不生效。
   */
  const [filtersOpen, setFiltersOpen] = useState(false);

  const divRef = useKeyDownActions({ onCancel: onClose });

  const persistRules = useMemo(
    () =>
      debounce((next: RandomPickRules) => {
        const store = useSettingsStore.getState();
        const merged = { ...store.settings, randomPickRules: next };
        store.setSettings(merged);
        void store.saveSettings(envConfig, merged);
      }, RULES_PERSIST_DELAY_MS),
    [envConfig],
  );
  // 关闭弹窗前把还在防抖窗口里的规则落盘，否则「改完立刻关」会丢配置。
  useEffect(() => () => persistRules.flush(), [persistRules]);
  // isSpinning 的生命周期属于弹窗：动画途中被关闭时必须复位，否则下次打开
  // 按钮会直接渲染成「跳过」。
  useEffect(() => () => setSpinning(false), [setSpinning]);

  const candidatePool = useMemo(
    () => buildCandidatePool(visibleLibrary, rules),
    [visibleLibrary, rules],
  );
  const groupCounts = useMemo(() => buildGroupCounts(visibleLibrary), [visibleLibrary]);

  // 预览轨道只跟候选池的「成员集合」绑定：书架后台同步（阅读进度、封面缩略图）
  // 会不断换掉 visibleLibrary 的引用，若跟着它重建，静态预览就会不停换书。
  const poolKey = useMemo(
    () => candidatePool.pool.map((book) => book.hash).join('|'),
    [candidatePool],
  );
  const previewTrack = useMemo(() => {
    if (track) return null;
    const { pool } = candidatePool;
    if (pool.length === 0) return null;
    return buildCarouselTrack(pool, pool[Math.floor(pool.length / 2)]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, poolKey]);

  const displayTrack = track ?? previewTrack;

  const handleRulesChange = (patch: Partial<RandomPickRules>) => {
    const next = normalizeRandomPickRules({ ...rules, ...patch });
    setRules(next);
    persistRules(next);
  };

  const handleRestoreDefaults = () => {
    // 两个开关是使用偏好而非筛选条件，恢复默认时保留。
    const next: RandomPickRules = {
      ...DEFAULT_RANDOM_PICK_RULES,
      avoidRepeats: rules.avoidRepeats,
      skipAnimation: rules.skipAnimation,
    };
    setRules(next);
    persistRules(next);
  };

  const handleSpin = () => {
    const { pool } = candidatePool;
    const picked = rules.avoidRepeats ? pickedHashes : EMPTY_HASH_SET;
    const outcome = pickRandomBook(pool, picked);
    if (!outcome.book) {
      setNotice(
        outcome.reason === 'exhausted'
          ? _('All candidate books have been picked')
          : _('No books match the current filters'),
      );
      return;
    }
    const remaining = pool.filter((book) => !picked.has(book.hash));
    setNotice(null);
    setResult(null);
    setPendingTarget(outcome.book);
    setTrack(buildCarouselTrack(remaining.length > 0 ? remaining : pool, outcome.book));
    // 只剩一本候选时旋转没有意义，直接结算。
    setSkipRequested(remaining.length <= 1);
    setSpinning(true);
  };

  const handleSettled = useCallback(() => {
    setSpinning(false);
    setSkipRequested(false);
    if (!pendingTarget) return;
    setResult(pendingTarget);
    markPicked(pendingTarget.hash);
  }, [pendingTarget, markPicked, setSpinning]);

  const handleSkip = () => {
    if (isSpinning) setSkipRequested(true);
  };

  const effectiveSkip = rules.skipAnimation || skipRequested;

  return (
    <div
      ref={divRef}
      role='dialog'
      aria-label={_('Random Pick')}
      className='fixed inset-0 flex items-center justify-center bg-black/40'
      onClick={onClose}
    >
      <div
        className='modal-box bg-base-100 flex max-h-[88%] w-[95%] max-w-[760px] flex-col overflow-hidden rounded-2xl p-4 shadow-xl sm:w-[76%]'
        onClick={(event) => event.stopPropagation()}
      >
        {/* 弹窗是 fixed inset-0，会盖住窗口标题栏上的原生关闭按钮，
            因此必须自带一个明确的关闭入口。 */}
        <div className='mb-3 flex items-center justify-between gap-2'>
          <span className='w-6 shrink-0' />
          <h2 className='truncate text-lg font-bold'>{_('Random Pick')}</h2>
          <button
            type='button'
            aria-label={_('Close')}
            title={_('Close')}
            onClick={onClose}
            className='text-base-content/50 hover:text-base-content w-6 shrink-0'
          >
            <IoMdCloseCircle className='mx-auto h-5 w-5' />
          </button>
        </div>
        <button
          type='button'
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((prev) => !prev)}
          className='btn btn-ghost btn-sm mb-2 self-center sm:hidden'
        >
          {_('Filters')}
        </button>
        <div className='grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-[220px_1fr]'>
          <div className={clsx('min-h-0 sm:overflow-y-auto', !filtersOpen && 'hidden sm:block')}>
            <RandomPickFilters
              rules={rules}
              books={visibleLibrary}
              groupCounts={groupCounts}
              pool={candidatePool}
              onChange={handleRulesChange}
              onRestoreDefaults={handleRestoreDefaults}
            />
          </div>
          <div className='flex min-w-0 flex-col'>
            {/* min-h 保证结果卡片（封面 132px + padding）能完整落在舞台内，
                否则 absolute inset-0 的覆盖层会溢出并压住下方的按钮行。 */}
            <div className='relative min-h-[176px]' onClick={handleSkip}>
              {displayTrack ? (
                <CoverCarousel
                  track={displayTrack}
                  spinning={isSpinning}
                  skipAnimation={effectiveSkip}
                  onSettled={handleSettled}
                />
              ) : (
                <div className='bg-base-300/40 text-base-content/50 flex h-[150px] items-center justify-center rounded-xl text-sm'>
                  {_('No books match the current filters')}
                </div>
              )}
              {/* 覆盖层不透明：抽中后轨道会瞬时退回起点，不能让这一步透出来 */}
              {result && (
                <div className='bg-base-100 absolute inset-0 flex items-center justify-center rounded-xl'>
                  <RandomPickResultCard
                    book={result}
                    onStartReading={() => onOpenBook(result)}
                    onSpinAgain={handleSpin}
                  />
                </div>
              )}
            </div>
            <div className='mt-3 flex items-center gap-3'>
              <span className='text-base-content/50 min-w-0 flex-1 truncate text-xs'>
                {notice ??
                  (pickCount > 0 ? _('Picked this session: {{count}}', { count: pickCount }) : '')}
              </span>
              {pickCount > 0 && (
                <button
                  type='button'
                  className='shrink-0 text-xs text-blue-500'
                  onClick={resetPicked}
                >
                  {_('Reset Picked')}
                </button>
              )}
              {isSpinning ? (
                <button
                  type='button'
                  className='btn btn-ghost btn-sm shrink-0'
                  onClick={handleSkip}
                >
                  {_('Skip')}
                </button>
              ) : (
                <button
                  type='button'
                  className='btn btn-primary btn-sm shrink-0'
                  disabled={candidatePool.pool.length === 0}
                  onClick={handleSpin}
                >
                  {_('Start Random Pick')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RandomPickDialog;
