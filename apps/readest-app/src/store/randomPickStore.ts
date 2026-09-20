import { create } from 'zustand';

interface RandomPickState {
  /** 本次会话已抽中的书籍 hash */
  pickedHashes: Set<string>;
  /** 是否正在播放滚轮动画 */
  isSpinning: boolean;
  /** 本次会话已抽数量，等于 pickedHashes.size，单独存是为了让订阅者拿到稳定标量 */
  pickCount: number;
  markPicked: (hash: string) => void;
  setSpinning: (spinning: boolean) => void;
  resetPicked: () => void;
}

/**
 * 本次会话的抽签状态。刻意不持久化：应用重启即清空。
 * 既符合「本次会话内不重复」的产品决策，也避免长期黑名单把候选池永久收窄。
 *
 * 这里不保存「上一次抽中的书」：结果卡片关闭后不再需要它，
 * 真正决定「稍后展示什么」的是抽奖过程中持有的 pendingTarget。
 */
export const useRandomPickStore = create<RandomPickState>((set) => ({
  pickedHashes: new Set<string>(),
  isSpinning: false,
  pickCount: 0,

  markPicked: (hash) =>
    set((state) => {
      if (state.pickedHashes.has(hash)) return state;
      const pickedHashes = new Set(state.pickedHashes);
      pickedHashes.add(hash);
      return { pickedHashes, pickCount: pickedHashes.size };
    }),

  setSpinning: (spinning) => set({ isSpinning: spinning }),

  resetPicked: () => set({ pickedHashes: new Set<string>(), pickCount: 0 }),
}));
