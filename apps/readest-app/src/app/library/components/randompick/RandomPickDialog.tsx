import React, { useCallback, useEffect, useMemo, useState } from 'react';

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

  const candidatePool = useMemo(
    () => buildCandidatePool(visibleLibrary, rules),
    [visibleLibrary, rules],
  );
  const groupCounts = useMemo(() => buildGroupCounts(visibleLibrary), [visibleLibrary]);

  // 抽奖前的静态占位轨道：取候选池正中间那本作为「高亮位」，纯装饰。
  const previewTrack = useMemo(() => {
    const { pool } = candidatePool;
    if (pool.length === 0) return null;
    return buildCarouselTrack(pool, pool[Math.floor(pool.length / 2)]!);
  }, [candidatePool]);

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
      className='fixed inset-0 flex items-center justify-center'
      onClick={onClose}
    >
      <div
        className='modal-box bg-base-100 flex max-h-[88%] w-[95%] max-w-[760px] flex-col overflow-hidden rounded-2xl p-4 shadow-xl sm:w-[76%]'
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className='mb-3 text-center text-lg font-bold'>{_('Random Pick')}</h2>
        <div className='grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-[220px_1fr]'>
          <div className='min-h-0 sm:overflow-y-auto'>
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
            <div className='relative' onClick={handleSkip}>
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
              {result && (
                <div className='bg-base-100/90 absolute inset-0 flex items-center justify-center rounded-xl backdrop-blur-sm'>
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
