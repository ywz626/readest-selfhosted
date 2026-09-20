import React, { useCallback, useEffect, useRef, useState } from 'react';

import BookCover from '@/components/BookCover';
import { CAROUSEL_CARD_GAP, CarouselTrack } from '../../utils/randomPickUtils';

/** 与下方 transition 的时长保持一致 */
const SPIN_DURATION_MS = 2200;
/**
 * transitionend 可能因为 transition 被合并/中断而不触发（例如动画途中改了
 * transition-duration），超时兜底结算，否则弹窗会永远停在「抽奖中」。
 */
const SETTLE_FALLBACK_MS = SPIN_DURATION_MS + 200;
const EASING = 'cubic-bezier(0.15, 0.85, 0.2, 1)';
const MIN_CARD_WIDTH = 48;
const MAX_CARD_WIDTH = 72;
/** 视口内大致展示的封面数量，用来反推单张卡片宽度 */
const VISIBLE_CARDS = 7;
const CARD_ASPECT = 1.5;

interface CoverCarouselProps {
  track: CarouselTrack;
  /** 正在播放抽奖动画 */
  spinning: boolean;
  /** 本次不使用动画，直接停在终点 */
  skipAnimation: boolean;
  /** 动画结束或被跳过时触发一次 */
  onSettled: () => void;
}

/** 轨道的水平位移与过渡时长；duration 为 0 表示瞬时对位 */
interface RailPosition {
  x: number;
  duration: number;
}

const CoverCarousel: React.FC<CoverCarouselProps> = ({
  track,
  spinning,
  skipAnimation,
  onSettled,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [rail, setRail] = useState<RailPosition>({ x: 0, duration: 0 });

  // 用 ref 持有回调，避免父组件每次渲染重建函数时打断结算副作用。
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    setContainerWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const cardWidth = Math.round(
    Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, containerWidth / VISIBLE_CARDS)),
  );
  const cardHeight = Math.round(cardWidth * CARD_ASPECT);
  const step = cardWidth + CAROUSEL_CARD_GAP;
  // 让 targetIndex 那张卡落在容器水平中心，再叠加一点随机抖动，
  // 使每次停位不会像素级一致。
  const targetX = -(
    track.targetIndex * step -
    (containerWidth / 2 - cardWidth / 2) +
    track.jitter * cardWidth
  );
  // 抽奖副作用里要读最新位移，但不能把 targetX 放进依赖（容器尺寸变化会
  // 重启整段动画），因此经 ref 取值。
  const targetXRef = useRef(targetX);
  targetXRef.current = targetX;

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    settledRef.current = false;
    clearSettleTimer();

    if (!spinning) {
      // 空闲时退回轨道起点。抽中后结果卡片会盖住舞台，这一步看不见；未抽中时
      // 它保证每次「开始随机」都从轨道开头滚起 —— 否则前后两条轨道的目标下标
      // 都是末位，位移几乎为 0，看上去就是瞬间跳到结果。
      setRail({ x: 0, duration: 0 });
      return;
    }

    setRail({ x: targetXRef.current, duration: skipAnimation ? 0 : SPIN_DURATION_MS });

    if (skipAnimation) {
      settledRef.current = true;
      onSettledRef.current();
      return;
    }

    settleTimerRef.current = setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      onSettledRef.current();
    }, SETTLE_FALLBACK_MS);

    return clearSettleTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinning, skipAnimation, track]);

  const handleTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== 'transform') return;
    if (!spinning || settledRef.current) return;
    settledRef.current = true;
    onSettledRef.current();
  };

  return (
    <div
      ref={containerRef}
      className='bg-base-300/40 relative w-full overflow-hidden rounded-xl'
      style={{ height: cardHeight + 32 }}
    >
      <div className='absolute inset-0 [mask-image:linear-gradient(to_right,transparent,black_64px,black_calc(100%-64px),transparent)]'>
        <div
          className='will-change-transform absolute top-1/2 left-0 flex items-center'
          style={{
            gap: CAROUSEL_CARD_GAP,
            transform: `translate3d(${rail.x}px, -50%, 0)`,
            // 始终声明 transition，只用 duration 在「瞬时对位」与「播放动画」
            // 之间切换：若写成 `none`，浏览器可能把它与位移变更归到同一次样式
            // 计算里，从而不产生过渡。
            transition: `transform ${rail.duration}ms ${EASING}`,
          }}
          onTransitionEnd={handleTransitionEnd}
        >
          {track.books.map((book, index) => (
            <div
              // 轨道允许同一本书重复出现，因此 key 必须带上下标
              key={`${book.hash}-${index}`}
              className='shrink-0 overflow-hidden rounded-md shadow-md'
              style={{ width: cardWidth, height: cardHeight }}
            >
              <BookCover book={book} mode='grid' coverFit='crop' />
            </div>
          ))}
        </div>
      </div>
      <div className='pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-amber-400' />
      <div className='pointer-events-none absolute top-1 left-1/2 -translate-x-1/2 border-x-[7px] border-t-[11px] border-b-0 border-x-transparent border-t-amber-400' />
    </div>
  );
};

export default CoverCarousel;
