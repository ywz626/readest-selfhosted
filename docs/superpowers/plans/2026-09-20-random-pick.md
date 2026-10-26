# 随机选书（Random Pick）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在书架页新增「随机选书」功能：以封面滚轮动画从可筛选的候选池中随机抽出一本书，并一键开始阅读。

**架构：** 纯逻辑（分组匹配、候选池过滤、随机抽取、轨道构造）放在 `randomPickUtils.ts`，无 React 无副作用、随机源可注入；本次会话的抽签状态放独立 zustand store（不持久化）；筛选规则挂在 `SystemSettings.randomPickRules`（设备本地，不进同步白名单）。UI 拆成 5 个小组件（滚轮 / 分组选择器 / 筛选面板 / 结果卡片 / 弹窗编排），滚轮复用既有 `BookCover`。

**技术栈：** TypeScript、React 19、Next.js 16（App Router）、zustand、Tailwind + daisyUI、vitest + @testing-library/react、Tauri 2（NSIS）

**规格：** `docs/superpowers/specs/2026-09-20-random-pick-design.md`

**工作目录：** 所有命令默认在 `apps/readest-app` 下执行。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/types/settings.ts`（改） | `RandomPickRules` 接口 + `SystemSettings.randomPickRules` 字段 |
| `src/services/constants.ts`（改） | `DEFAULT_RANDOM_PICK_RULES` 并挂入 `DEFAULT_SYSTEM_SETTINGS` |
| `src/app/library/utils/randomPickUtils.ts`（新） | 纯逻辑：分组层级匹配、分组计数、规则归一化、候选池构造、随机抽取、轨道构造 |
| `src/store/randomPickStore.ts`（新） | 会话内已抽 hash、上次结果、抽奖中标记 |
| `src/app/library/components/randompick/CoverCarousel.tsx`（新） | 封面滚轮动画 |
| `src/app/library/components/randompick/GroupMultiPicker.tsx`（新） | 分组层级选择器（选一个分组） |
| `src/app/library/components/randompick/RandomPickFilters.tsx`（新） | 筛选面板（白名单 / 黑名单 / 排除书籍 / 开关） |
| `src/app/library/components/randompick/RandomPickResultCard.tsx`（新） | 结果卡片 |
| `src/app/library/components/randompick/RandomPickDialog.tsx`（新） | 弹窗编排 |
| `src/app/library/components/LibraryHeader.tsx`（改） | 入口按钮 + `onOpenRandomPick` prop |
| `src/app/library/page.tsx`（改） | `showRandomPick` state、`useOpenBook` 接线、`ModalPortal` 渲染 |
| `public/locales/*/translation.json`（改） | `pnpm i18n:extract` 生成；中文译文手工补 `zh-CN` |

测试文件：

| 文件 | 覆盖 |
| --- | --- |
| `src/__tests__/utils/random-pick-utils.test.ts` | 全部纯函数 |
| `src/__tests__/store/random-pick-store.test.ts` | store action |
| `src/__tests__/components/CoverCarousel.test.tsx` | 滚轮渲染与结算回调 |
| `src/__tests__/components/GroupMultiPicker.test.tsx` | 层级导航与选择回调 |
| `src/__tests__/components/RandomPickResultCard.test.tsx` | 结果卡片渲染与按钮 |
| `src/__tests__/components/RandomPickFilters.test.tsx` | 白/黑名单操作与规则冒泡 |
| `src/__tests__/components/RandomPickDialog.test.tsx` | 端到端编排 |
| `src/__tests__/components/LibraryHeader.test.tsx` | 工具栏入口按钮 |

---

## 任务 1：候选池与随机抽取的纯逻辑

**文件：**
- 修改：`src/types/settings.ts`
- 修改：`src/services/constants.ts`
- 创建：`src/app/library/utils/randomPickUtils.ts`
- 测试：`src/__tests__/utils/random-pick-utils.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/__tests__/utils/random-pick-utils.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import {
  buildCandidatePool,
  buildCarouselTrack,
  buildGroupCounts,
  groupMatches,
  normalizeRandomPickRules,
  pickRandomBook,
} from '../../app/library/utils/randomPickUtils';
import { Book } from '../../types/book';
import { RandomPickRules } from '../../types/settings';

const makeBook = (overrides: Partial<Book> & { hash: string }): Book =>
  ({
    format: 'EPUB',
    title: `Book ${overrides.hash}`,
    author: 'Author',
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

/** 依次返回给定值的 rng，用尽后重复最后一个值 */
const seqRng = (...values: number[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
};

describe('groupMatches', () => {
  it('matches an exact group path', () => {
    expect(groupMatches('文学', ['文学'])).toBe(true);
  });

  it('matches a descendant path', () => {
    expect(groupMatches('文学/小说', ['文学'])).toBe(true);
  });

  it('does not match a sibling sharing a name prefix', () => {
    expect(groupMatches('文学史', ['文学'])).toBe(false);
  });

  it('never matches an empty (ungrouped) path', () => {
    expect(groupMatches('', ['文学'])).toBe(false);
  });

  it('does not match when the group list is empty', () => {
    expect(groupMatches('文学', [])).toBe(false);
  });
});

describe('normalizeRandomPickRules', () => {
  it('falls back to defaults for undefined input', () => {
    expect(normalizeRandomPickRules(undefined)).toEqual(makeRules());
  });

  it('ignores unknown keys and fills missing ones', () => {
    expect(normalizeRandomPickRules({ excludeBooks: ['a'] })).toEqual(
      makeRules({ excludeBooks: ['a'] }),
    );
  });

  it('drops non-string group entries and dedupes', () => {
    expect(normalizeRandomPickRules({ includeGroups: ['a', 'a', '', 3, null] }).includeGroups)
      .toEqual(['a']);
  });

  it('falls back when a boolean field has the wrong type', () => {
    expect(normalizeRandomPickRules({ avoidRepeats: 'yes' }).avoidRepeats).toBe(true);
    expect(normalizeRandomPickRules({ skipAnimation: 1 }).skipAnimation).toBe(false);
  });

  it('preserves explicit false', () => {
    expect(normalizeRandomPickRules({ avoidRepeats: false }).avoidRepeats).toBe(false);
  });
});

describe('buildGroupCounts', () => {
  it('counts a book towards every ancestor path', () => {
    const counts = buildGroupCounts([
      makeBook({ hash: 'a', groupName: '文学/小说' }),
      makeBook({ hash: 'b', groupName: '文学/诗集' }),
      makeBook({ hash: 'c', groupName: '文学' }),
      makeBook({ hash: 'd' }),
    ]);
    expect(counts.get('文学')).toBe(3);
    expect(counts.get('文学/小说')).toBe(1);
    expect(counts.get('文学/诗集')).toBe(1);
    expect(counts.size).toBe(3);
  });
});

describe('buildCandidatePool', () => {
  const books = [
    makeBook({ hash: 'a', groupName: '文学/小说' }),
    makeBook({ hash: 'b', groupName: '文学/诗集' }),
    makeBook({ hash: 'c', groupName: '技术' }),
    makeBook({ hash: 'd' }),
    makeBook({ hash: 'e', groupName: '文学史' }),
  ];

  it('returns the whole library when no rule is set', () => {
    const result = buildCandidatePool(books, makeRules());
    expect(result.pool).toHaveLength(5);
    expect(result.total).toBe(5);
    expect(result.excluded).toBe(0);
  });

  it('restricts to the include list with descendant matching', () => {
    const result = buildCandidatePool(books, makeRules({ includeGroups: ['文学'] }));
    expect(result.pool.map((book) => book.hash)).toEqual(['a', 'b']);
    expect(result.excluded).toBe(3);
  });

  it('excludes ungrouped books when the include list is set', () => {
    const result = buildCandidatePool(books, makeRules({ includeGroups: ['文学'] }));
    expect(result.pool.some((book) => book.hash === 'd')).toBe(false);
  });

  it('applies the exclude list on top of the whole library', () => {
    const result = buildCandidatePool(books, makeRules({ excludeGroups: ['文学'] }));
    expect(result.pool.map((book) => book.hash)).toEqual(['c', 'd', 'e']);
  });

  it('gives the exclude list priority over the include list', () => {
    const result = buildCandidatePool(
      books,
      makeRules({ includeGroups: ['文学'], excludeGroups: ['文学/小说'] }),
    );
    expect(result.pool.map((book) => book.hash)).toEqual(['b']);
  });

  it('can produce an empty pool when the two lists cancel out', () => {
    const result = buildCandidatePool(
      books,
      makeRules({ includeGroups: ['文学'], excludeGroups: ['文学'] }),
    );
    expect(result.pool).toHaveLength(0);
    expect(result.excluded).toBe(5);
  });

  it('drops explicitly excluded books by hash', () => {
    const result = buildCandidatePool(books, makeRules({ excludeBooks: ['a', 'c'] }));
    expect(result.pool.map((book) => book.hash)).toEqual(['b', 'd', 'e']);
  });
});

describe('pickRandomBook', () => {
  const pool = ['a', 'b', 'c'].map((hash) => makeBook({ hash }));

  it('returns the first candidate when rng yields 0', () => {
    expect(pickRandomBook(pool, new Set(), seqRng(0)).book?.hash).toBe('a');
  });

  it('returns the last candidate when rng approaches 1', () => {
    expect(pickRandomBook(pool, new Set(), seqRng(0.999)).book?.hash).toBe('c');
  });

  it('never overflows the candidate array when rng returns exactly 1', () => {
    expect(pickRandomBook(pool, new Set(), seqRng(1)).book?.hash).toBe('c');
  });

  it('skips already picked books', () => {
    expect(pickRandomBook(pool, new Set(['a', 'b']), seqRng(0)).book?.hash).toBe('c');
  });

  it('reports exhaustion when every book has been picked', () => {
    const outcome = pickRandomBook(pool, new Set(['a', 'b', 'c']), seqRng(0));
    expect(outcome.book).toBeNull();
    expect(outcome.reason).toBe('exhausted');
  });

  it('reports an empty pool distinctly from exhaustion', () => {
    const outcome = pickRandomBook([], new Set(), seqRng(0));
    expect(outcome.book).toBeNull();
    expect(outcome.reason).toBe('empty-pool');
  });
});

describe('buildCarouselTrack', () => {
  const pool = Array.from({ length: 10 }, (_, i) => makeBook({ hash: `h${i}` }));
  const target = pool[4]!;

  it('always places the target last', () => {
    const track = buildCarouselTrack(pool, target, seqRng(0.3), 8);
    expect(track.books).toHaveLength(8);
    expect(track.targetIndex).toBe(7);
    expect(track.books[7]!.hash).toBe(target.hash);
  });

  it('never shows the target before the final slot', () => {
    const track = buildCarouselTrack(pool, target, seqRng(0.42), 12);
    expect(track.books.slice(0, 11).some((book) => book.hash === target.hash)).toBe(false);
  });

  it('tiles the whole track with the target when the pool holds only it', () => {
    const track = buildCarouselTrack([target], target, seqRng(0.5), 4);
    expect(track.books.map((book) => book.hash)).toEqual([
      target.hash,
      target.hash,
      target.hash,
      target.hash,
    ]);
  });

  it('keeps the jitter inside [-0.35, 0.35]', () => {
    expect(buildCarouselTrack(pool, target, seqRng(0), 4).jitter).toBeCloseTo(-0.35);
    expect(buildCarouselTrack(pool, target, seqRng(1), 4).jitter).toBeCloseTo(0.35);
  });

  it('clamps a track length below 2', () => {
    const track = buildCarouselTrack(pool, target, seqRng(0.5), 1);
    expect(track.books).toHaveLength(2);
    expect(track.targetIndex).toBe(1);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/__tests__/utils/random-pick-utils.test.ts`
预期：FAIL，报错 `Failed to resolve import "../../app/library/utils/randomPickUtils"`

- [ ] **步骤 3：新增 `RandomPickRules` 类型**

在 `src/types/settings.ts` 中找到 `export type LibraryGroupByType = (typeof LibraryGroupByType)[keyof typeof LibraryGroupByType];`，在其后插入：

```ts
/**
 * 随机选书的候选池筛选规则。
 *
 * 设备本地偏好：刻意不进 SETTINGS_WHITELIST（与 libraryGroupBy 一致），
 * 否则「在 A 设备排除掉的分组在 B 设备也被排除」会非常意外。
 */
export interface RandomPickRules {
  /** 分组全路径白名单。空数组表示不限制（全库） */
  includeGroups: string[];
  /** 分组全路径黑名单，在白名单结果之上剔除，优先级更高 */
  excludeGroups: string[];
  /** 被排除书籍的 hash */
  excludeBooks: string[];
  /** 本次会话内不重复抽同一本书 */
  avoidRepeats: boolean;
  /** 跳过滚轮动画，直接出结果 */
  skipAnimation: boolean;
}
```

在 `SystemSettings` 接口中找到 `libraryRecentShelfEnabled: boolean;`，在其后插入：

```ts
  /** 随机选书的候选池筛选规则。设备本地，不参与设置同步。 */
  randomPickRules?: RandomPickRules;
```

- [ ] **步骤 4：新增默认值常量**

在 `src/services/constants.ts` 中，把 `RandomPickRules` 加入 `from '@/types/settings'` 的导入列表（与 `LibraryGroupByType` 同组）。然后在 `export const DEFAULT_SYSTEM_SETTINGS: Partial<SystemSettings> = {` 之前插入：

```ts
export const DEFAULT_RANDOM_PICK_RULES: RandomPickRules = {
  includeGroups: [],
  excludeGroups: [],
  excludeBooks: [],
  avoidRepeats: true,
  skipAnimation: false,
};
```

在 `DEFAULT_SYSTEM_SETTINGS` 中找到 `libraryRecentShelfEnabled: false,`，在其后插入：

```ts
  randomPickRules: DEFAULT_RANDOM_PICK_RULES,
```

- [ ] **步骤 5：实现 `randomPickUtils.ts`**

创建 `src/app/library/utils/randomPickUtils.ts`：

```ts
import { Book } from '@/types/book';
import { RandomPickRules } from '@/types/settings';
import { DEFAULT_RANDOM_PICK_RULES } from '@/services/constants';

/** 模块级空集合，供「不排除任何已抽书籍」的调用方复用，避免每次渲染新建 Set。 */
export const EMPTY_HASH_SET: ReadonlySet<string> = new Set<string>();

/** 滚轮中两张封面之间的水平间距（px）。组件与位移计算共用同一常量。 */
export const CAROUSEL_CARD_GAP = 12;

/** 滚轮轨道的默认卡片数。 */
export const CAROUSEL_TRACK_LENGTH = 36;

const CAROUSEL_JITTER = 0.35;

export interface CandidatePool {
  /** 最终候选池 */
  pool: Book[];
  /** 传入书籍总数 */
  total: number;
  /** 被规则排除的数量 */
  excluded: number;
}

export interface PickOutcome {
  book: Book | null;
  reason?: 'empty-pool' | 'exhausted';
}

export interface CarouselTrack {
  /** 轨道上的书籍，末位固定为 target */
  books: Book[];
  /** target 在轨道中的下标 */
  targetIndex: number;
  /** 终点位移的随机抖动比例，取值 [-0.35, 0.35] */
  jitter: number;
}

/**
 * 分组层级匹配：path 等于 groups 中任一项，或是其子层级（以 `/` 为边界）。
 * 选中「文学」覆盖「文学」与「文学/小说」，但不覆盖「文学史」。
 * 未分组的空路径不匹配任何非空分组项。
 */
export const groupMatches = (path: string, groups: readonly string[]): boolean => {
  if (!path) return false;
  return groups.some((group) => path === group || path.startsWith(`${group}/`));
};

/**
 * 统计每个分组（含所有祖先路径）的书目数。
 * `文学/小说` 下的一本书同时计入 `文学` 与 `文学/小说`。
 */
export const buildGroupCounts = (books: readonly Book[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const book of books) {
    let prefix = book.groupName ?? '';
    while (prefix) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      const slash = prefix.lastIndexOf('/');
      prefix = slash > 0 ? prefix.slice(0, slash) : '';
    }
  }
  return counts;
};

const toStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && item !== '') seen.add(item);
  }
  return [...seen];
};

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/**
 * 兜底历史 / 脏数据：字段缺失或类型不对时回落默认值。
 * 老版本 settings.json 里的 randomPickRules 形如 undefined 或残缺对象。
 */
export const normalizeRandomPickRules = (raw: unknown): RandomPickRules => {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    includeGroups: toStringList(source.includeGroups),
    excludeGroups: toStringList(source.excludeGroups),
    excludeBooks: toStringList(source.excludeBooks),
    avoidRepeats: toBoolean(source.avoidRepeats, DEFAULT_RANDOM_PICK_RULES.avoidRepeats),
    skipAnimation: toBoolean(source.skipAnimation, DEFAULT_RANDOM_PICK_RULES.skipAnimation),
  };
};

/**
 * 由书籍列表与规则构造候选池。
 *
 * 规则顺序：白名单收窄 -> 黑名单剔除 -> 指定书籍剔除。
 * 黑名单优先级高于白名单，两者同时命中同一分组时该分组被排除。
 *
 * @param books 应为已剔除 deletedAt 的列表（调用方传 visibleLibrary）
 */
export const buildCandidatePool = (
  books: readonly Book[],
  rules: RandomPickRules,
): CandidatePool => {
  const { includeGroups, excludeGroups, excludeBooks } = rules;
  const included =
    includeGroups.length === 0
      ? books
      : books.filter((book) => groupMatches(book.groupName ?? '', includeGroups));
  const excludedHashes = new Set(excludeBooks);
  const pool = included.filter(
    (book) =>
      !excludedHashes.has(book.hash) && !groupMatches(book.groupName ?? '', excludeGroups),
  );
  return { pool, total: books.length, excluded: books.length - pool.length };
};

/**
 * 均匀随机抽一本。
 *
 * @param pickedHashes 需要排除的已抽 hash；调用方按 avoidRepeats 决定是否传 EMPTY_HASH_SET
 * @param rng 随机源，默认 Math.random；测试注入固定序列以获得确定性
 */
export const pickRandomBook = (
  pool: readonly Book[],
  pickedHashes: ReadonlySet<string>,
  rng: () => number = Math.random,
): PickOutcome => {
  if (pool.length === 0) return { book: null, reason: 'empty-pool' };
  const candidates = pool.filter((book) => !pickedHashes.has(book.hash));
  if (candidates.length === 0) return { book: null, reason: 'exhausted' };
  const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length));
  return { book: candidates[index]! };
};

/**
 * 构造滚轮轨道：末位固定为 target，前面用池内其他书随机填充。
 * 池不足时允许重复填充，但绝不提前放入 target（池只有 1 本时整条轨道都是它）。
 */
export const buildCarouselTrack = (
  pool: readonly Book[],
  target: Book,
  rng: () => number = Math.random,
  length: number = CAROUSEL_TRACK_LENGTH,
): CarouselTrack => {
  const trackLength = Math.max(2, length);
  const others = pool.filter((book) => book.hash !== target.hash);
  const books: Book[] = [];
  for (let i = 0; i < trackLength - 1; i++) {
    if (others.length === 0) {
      books.push(target);
      continue;
    }
    const index = Math.min(others.length - 1, Math.floor(rng() * others.length));
    books.push(others[index]!);
  }
  books.push(target);
  return {
    books,
    targetIndex: trackLength - 1,
    jitter: rng() * CAROUSEL_JITTER * 2 - CAROUSEL_JITTER,
  };
};
```

- [ ] **步骤 6：运行测试验证通过**

运行：`pnpm vitest run src/__tests__/utils/random-pick-utils.test.ts`
预期：PASS，全部用例通过

- [ ] **步骤 7：类型与 lint 检查**

运行：`pnpm exec tsc --noEmit`
预期：无错误

- [ ] **步骤 8：Commit**

```bash
cd apps/readest-app
git add src/types/settings.ts src/services/constants.ts src/app/library/utils/randomPickUtils.ts src/__tests__/utils/random-pick-utils.test.ts
git commit -m "feat(library): random pick candidate pool and draw logic"
```

---

## 任务 2：会话状态 store

**文件：**
- 创建：`src/store/randomPickStore.ts`
- 测试：`src/__tests__/store/random-pick-store.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/__tests__/store/random-pick-store.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { useRandomPickStore } from '@/store/randomPickStore';

const resetStore = () =>
  useRandomPickStore.setState({
    pickedHashes: new Set<string>(),
    isSpinning: false,
    pickCount: 0,
  });

describe('randomPickStore', () => {
  beforeEach(resetStore);

  it('accumulates picked hashes and keeps pickCount in sync', () => {
    useRandomPickStore.getState().markPicked('a');
    useRandomPickStore.getState().markPicked('b');
    const state = useRandomPickStore.getState();
    expect([...state.pickedHashes].sort()).toEqual(['a', 'b']);
    expect(state.pickCount).toBe(2);
  });

  it('ignores a repeated hash and keeps the Set reference stable', () => {
    useRandomPickStore.getState().markPicked('a');
    const before = useRandomPickStore.getState().pickedHashes;
    useRandomPickStore.getState().markPicked('a');
    const state = useRandomPickStore.getState();
    expect(state.pickCount).toBe(1);
    expect(state.pickedHashes).toBe(before);
  });

  it('replaces the Set instance on a new hash so subscribers re-render', () => {
    const before = useRandomPickStore.getState().pickedHashes;
    useRandomPickStore.getState().markPicked('a');
    expect(useRandomPickStore.getState().pickedHashes).not.toBe(before);
  });

  it('tracks the spinning flag', () => {
    useRandomPickStore.getState().setSpinning(true);
    expect(useRandomPickStore.getState().isSpinning).toBe(true);
    useRandomPickStore.getState().setSpinning(false);
    expect(useRandomPickStore.getState().isSpinning).toBe(false);
  });

  it('clears picked hashes and the counter on reset', () => {
    const store = useRandomPickStore.getState();
    store.markPicked('a');
    store.resetPicked();
    const state = useRandomPickStore.getState();
    expect(state.pickedHashes.size).toBe(0);
    expect(state.pickCount).toBe(0);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/__tests__/store/random-pick-store.test.ts`
预期：FAIL，报错 `Failed to resolve import "@/store/randomPickStore"`

- [ ] **步骤 3：实现 store**

创建 `src/store/randomPickStore.ts`：

```ts
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/__tests__/store/random-pick-store.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd apps/readest-app
git add src/store/randomPickStore.ts src/__tests__/store/random-pick-store.test.ts
git commit -m "feat(library): session-scoped random pick store"
```

---

## 任务 3：封面滚轮组件

**文件：**
- 创建：`src/app/library/components/randompick/CoverCarousel.tsx`
- 测试：`src/__tests__/components/CoverCarousel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

创建 `src/__tests__/components/CoverCarousel.test.tsx`：

```tsx
import { act, cleanup, render, screen } from '@testing-library/react';
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

import CoverCarousel from '@/app/library/components/randompick/CoverCarousel';
import { buildCarouselTrack } from '@/app/library/utils/randomPickUtils';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { Book } from '@/types/book';
import { SystemSettings } from '@/types/settings';

const makeBook = (hash: string): Book =>
  ({
    hash,
    title: `Book ${hash}`,
    author: 'Author',
    format: 'EPUB',
    createdAt: 0,
    updatedAt: 0,
  }) as Book;

const pool = ['a', 'b', 'c', 'd'].map(makeBook);
const track = buildCarouselTrack(pool, pool[2]!, () => 0.5, 6);

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useLibraryStore.setState({ coverThumbnails: new Map(), library: [], hashIndex: new Map() });
  useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CoverCarousel', () => {
  it('renders one cover per track slot', () => {
    const { container } = render(
      <CoverCarousel track={track} spinning={false} skipAnimation={false} onSettled={vi.fn()} />,
    );
    expect(container.querySelectorAll('.book-cover-container')).toHaveLength(track.books.length);
  });

  it('renders the target title so the settled cover is identifiable', () => {
    render(
      <CoverCarousel track={track} spinning={false} skipAnimation={false} onSettled={vi.fn()} />,
    );
    expect(screen.getAllByText(`Book ${track.books[track.targetIndex]!.hash}`).length).toBeGreaterThan(
      0,
    );
  });

  it('settles synchronously when the animation is skipped', () => {
    const onSettled = vi.fn();
    render(
      <CoverCarousel track={track} spinning skipAnimation onSettled={onSettled} />,
    );
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('settles through the fallback timer when the transition never fires', () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    render(
      <CoverCarousel track={track} spinning skipAnimation={false} onSettled={onSettled} />,
    );
    expect(onSettled).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('does not settle twice when the transition and the timer both fire', () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const { container } = render(
      <CoverCarousel track={track} spinning skipAnimation={false} onSettled={onSettled} />,
    );
    const rail = container.querySelector('.will-change-transform')!;
    // jsdom 没有 TransitionEvent，手工挂上 propertyName，否则 handleTransitionEnd
    // 会因为属性名不匹配而提前返回，用例就测不到「重复结算」这条路径。
    const transitionEnd = new Event('transitionend', { bubbles: true });
    Object.defineProperty(transitionEnd, 'propertyName', { value: 'transform' });
    act(() => {
      rail.dispatchEvent(transitionEnd);
      vi.advanceTimersByTime(2500);
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/__tests__/components/CoverCarousel.test.tsx`
预期：FAIL，报错 `Failed to resolve import "@/app/library/components/randompick/CoverCarousel"`

- [ ] **步骤 3：实现 `CoverCarousel.tsx`**

创建 `src/app/library/components/randompick/CoverCarousel.tsx`：

```tsx
import React, { useEffect, useRef, useState } from 'react';

import BookCover from '@/components/BookCover';
import { CAROUSEL_CARD_GAP, CarouselTrack } from '../utils/randomPickUtils';

/** 与下方 CSS transition 的时长保持一致 */
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

const CoverCarousel: React.FC<CoverCarouselProps> = ({
  track,
  spinning,
  skipAnimation,
  onSettled,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef(false);
  const [containerWidth, setContainerWidth] = useState(0);

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
  const offset =
    track.targetIndex * step - (containerWidth / 2 - cardWidth / 2) + track.jitter * cardWidth;
  const animating = spinning && !skipAnimation;

  useEffect(() => {
    settledRef.current = false;
    if (!spinning) return;
    if (skipAnimation) {
      settledRef.current = true;
      onSettledRef.current();
      return;
    }
    const timer = setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      onSettledRef.current();
    }, SETTLE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [spinning, skipAnimation, track]);

  const handleTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== 'transform') return;
    if (!animating || settledRef.current) return;
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
            transform: `translate3d(${-offset}px, -50%, 0)`,
            transition: animating ? `transform ${SPIN_DURATION_MS}ms ${EASING}` : 'none',
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
      <div className='pointer-events-none absolute top-1 left-1/2 -translate-x-1/2 border-x-[7px] border-t-[11px] border-x-transparent border-t-amber-400' />
    </div>
  );
};

export default CoverCarousel;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/__tests__/components/CoverCarousel.test.tsx`
预期：PASS，5 个用例通过

- [ ] **步骤 5：Commit**

```bash
cd apps/readest-app
git add src/app/library/components/randompick/CoverCarousel.tsx src/__tests__/components/CoverCarousel.test.tsx
git commit -m "feat(library): random pick cover carousel"
```

---

## 任务 4：分组选择器

**文件：**
- 创建：`src/app/library/components/randompick/GroupMultiPicker.tsx`
- 测试：`src/__tests__/components/GroupMultiPicker.test.tsx`

**契约：** 这是一个「选一个分组」的单选器，由 `RandomPickFilters` 以浮层形式打开；选中后回调 `onSelect(groupName)`，由调用方决定加入白名单还是黑名单。分组浏览复用 `GroupingModal` 的层级导航模式，但**不**与 `GroupingModal` 抽取公共组件（后者承担建组/重命名/移出分组，语义不同，耦合成本高于这 40 行的导航逻辑重复）。

- [ ] **步骤 1：编写失败的测试**

创建 `src/__tests__/components/GroupMultiPicker.test.tsx`：

```tsx
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/__tests__/components/GroupMultiPicker.test.tsx`
预期：FAIL，报错 `Failed to resolve import "@/app/library/components/randompick/GroupMultiPicker"`

- [ ] **步骤 3：实现 `GroupMultiPicker.tsx`**

创建 `src/app/library/components/randompick/GroupMultiPicker.tsx`：

```tsx
import React, { useMemo, useState } from 'react';
import { HiOutlineFolder } from 'react-icons/hi';
import { MdCheck, MdChevronRight } from 'react-icons/md';

import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { getBreadcrumbs } from '../utils/libraryUtils';

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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/__tests__/components/GroupMultiPicker.test.tsx`
预期：PASS，7 个用例通过

如果 `nested group` 用例失败，检查 `getGroupsByParent` 是否真的返回了子分组——它依赖 `getParentPath('文学/小说') === '文学'`。父路径由 store 计算，不要在此处自己拼。

- [ ] **步骤 5：Commit**

```bash
cd apps/readest-app
git add src/app/library/components/randompick/GroupMultiPicker.tsx src/__tests__/components/GroupMultiPicker.test.tsx
git commit -m "feat(library): group picker for random pick filters"
```

---

## 任务 5：结果卡片

**文件：**
- 创建：`src/app/library/components/randompick/RandomPickResultCard.tsx`
- 测试：`src/__tests__/components/RandomPickResultCard.test.tsx`

- [ ] **步骤 1：编写失败的测试**

创建 `src/__tests__/components/RandomPickResultCard.test.tsx`：

```tsx
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
    expect(screen.getAllByText('Dune').length).toBeGreaterThan(0);
    expect(screen.getByText('Frank Herbert')).toBeTruthy();
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
      <RandomPickResultCard book={makeBook()} onStartReading={onStartReading} onSpinAgain={vi.fn()} />,
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/__tests__/components/RandomPickResultCard.test.tsx`
预期：FAIL，报错 `Failed to resolve import "@/app/library/components/randompick/RandomPickResultCard"`

- [ ] **步骤 3：实现 `RandomPickResultCard.tsx`**

创建 `src/app/library/components/randompick/RandomPickResultCard.tsx`：

```tsx
import React from 'react';

import BookCover from '@/components/BookCover';
import { useTranslation } from '@/hooks/useTranslation';
import { Book, ReadingStatus } from '@/types/book';
import { formatAuthors, formatTitle } from '@/utils/book';

interface RandomPickResultCardProps {
  book: Book;
  onStartReading: () => void;
  onSpinAgain: () => void;
}

const RandomPickResultCard: React.FC<RandomPickResultCardProps> = ({
  book,
  onStartReading,
  onSpinAgain,
}) => {
  const _ = useTranslation();

  const statusLabel = (status?: ReadingStatus) => {
    switch (status) {
      case 'finished':
        return _('Finished');
      case 'abandoned':
        return _('On hold');
      case 'reading':
        return _('Reading');
      default:
        return _('Unread');
    }
  };

  const total = book.progress?.[1] ?? 0;
  const progressPercent = total > 0 ? Math.round(((book.progress?.[0] ?? 0) / total) * 100) : null;

  const metaLine = [book.groupName, book.format].filter(Boolean).join(' · ');
  const statusLine = [
    progressPercent === null ? null : _('{{count}}% read', { count: progressPercent }),
    statusLabel(book.readingStatus),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className='bg-base-100 flex items-center gap-4 rounded-xl p-4'>
      <div className='h-[132px] w-[88px] shrink-0 overflow-hidden rounded-md shadow-lg'>
        <BookCover book={book} mode='grid' coverFit='crop' />
      </div>
      <div className='min-w-0 flex-1'>
        <p className='text-xs font-medium text-amber-500'>{_('Pick Result')}</p>
        <h3 className='mt-0.5 truncate text-lg font-bold'>{formatTitle(book.title)}</h3>
        <p className='text-base-content/60 truncate text-sm'>
          {formatAuthors(book.author || book.metadata?.author || '')}
        </p>
        {metaLine && <p className='text-base-content/50 mt-2 text-xs'>{metaLine}</p>}
        <p className='text-base-content/50 text-xs'>{statusLine}</p>
        <div className='mt-3 flex flex-wrap gap-2'>
          <button type='button' className='btn btn-primary btn-sm' onClick={onStartReading}>
            {_('Start Reading')}
          </button>
          <button type='button' className='btn btn-ghost btn-sm' onClick={onSpinAgain}>
            {_('Spin Again')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RandomPickResultCard;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/__tests__/components/RandomPickResultCard.test.tsx`
预期：PASS，6 个用例通过

- [ ] **步骤 5：Commit**

```bash
cd apps/readest-app
git add src/app/library/components/randompick/RandomPickResultCard.tsx src/__tests__/components/RandomPickResultCard.test.tsx
git commit -m "feat(library): random pick result card"
```

---

## 任务 6：筛选面板

**文件：**
- 创建：`src/app/library/components/randompick/RandomPickFilters.tsx`
- 测试：`src/__tests__/components/RandomPickFilters.test.tsx`

- [ ] **步骤 1：编写失败的测试**

创建 `src/__tests__/components/RandomPickFilters.test.tsx`：

```tsx
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
    fireEvent.click(screen.getByText('Dune'));
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/__tests__/components/RandomPickFilters.test.tsx`
预期：FAIL，报错 `Failed to resolve import "@/app/library/components/randompick/RandomPickFilters"`

- [ ] **步骤 3：实现 `RandomPickFilters.tsx`**

创建 `src/app/library/components/randompick/RandomPickFilters.tsx`：

```tsx
import React, { useMemo, useState } from 'react';
import { IoMdCloseCircle } from 'react-icons/io';
import { MdCheck } from 'react-icons/md';
import { PiPlus } from 'react-icons/pi';

import { useTranslation } from '@/hooks/useTranslation';
import { Book } from '@/types/book';
import { RandomPickRules } from '@/types/settings';
import { formatAuthors, formatTitle } from '@/utils/book';
import { createBookFilter } from '../utils/libraryUtils';
import { CandidatePool } from '../utils/randomPickUtils';
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
    const key = target === 'include' ? 'includeGroups' : 'excludeGroups';
    const current = rules[key];
    if (current.includes(name)) return;
    onChange({ [key]: [...current, name] } as Partial<RandomPickRules>);
  };

  const removeGroup = (target: GroupPickerTarget, name: string) => {
    const key = target === 'include' ? 'includeGroups' : 'excludeGroups';
    onChange({ [key]: rules[key].filter((item) => item !== name) } as Partial<RandomPickRules>);
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
            onSelect={(name) => addGroup(target, name)}
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
              <button type='button' aria-label={`${_('Remove')} ${hash}`} onClick={() => toggleBook(hash)}>
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

      <div className='space-y-2 border-t border-base-300 pt-3'>
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

      <div className='flex items-center justify-between border-t border-base-300 pt-3'>
        <span className='text-base-content/60 text-xs'>{poolSummary}</span>
        <button type='button' onClick={onRestoreDefaults} className='text-xs text-blue-500'>
          {_('Restore Defaults')}
        </button>
      </div>
    </div>
  );
};

export default RandomPickFilters;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/__tests__/components/RandomPickFilters.test.tsx`
预期：PASS，10 个用例通过

- [ ] **步骤 5：Commit**

```bash
cd apps/readest-app
git add src/app/library/components/randompick/RandomPickFilters.tsx src/__tests__/components/RandomPickFilters.test.tsx
git commit -m "feat(library): random pick filter panel"
```

---

## 任务 7：弹窗编排

**文件：**
- 创建：`src/app/library/components/randompick/RandomPickDialog.tsx`
- 测试：`src/__tests__/components/RandomPickDialog.test.tsx`

- [ ] **步骤 1：编写失败的测试**

创建 `src/__tests__/components/RandomPickDialog.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: async () => ({ saveSettings: vi.fn(async () => {}) }) },
    appService: null,
  }),
}));

import RandomPickDialog from '@/app/library/components/randompick/RandomPickDialog';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useLibraryStore } from '@/store/libraryStore';
import { useRandomPickStore } from '@/store/randomPickStore';
import { useSettingsStore } from '@/store/settingsStore';
import { Book } from '@/types/book';
import { SystemSettings } from '@/types/settings';

const makeBook = (overrides: Partial<Book> & { hash: string }): Book =>
  ({
    title: `Book ${overrides.hash}`,
    author: 'Author',
    format: 'EPUB',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Book;

const dune = makeBook({ hash: 'dune', title: 'Dune' });

const setLibrary = (books: Book[]) =>
  useLibraryStore.setState({
    visibleLibrary: books,
    library: books,
    coverThumbnails: new Map(),
    groups: {},
  });

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
  useRandomPickStore.setState({
    pickedHashes: new Set<string>(),
    isSpinning: false,
    pickCount: 0,
  });
  setLibrary([dune]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('RandomPickDialog', () => {
  it('disables the spin button when the candidate pool is empty', () => {
    setLibrary([]);
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    expect((screen.getByText('Start Random Pick') as HTMLButtonElement).disabled).toBe(true);
  });

  it('skips the animation and reveals the result for a single candidate', async () => {
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(screen.getByText('Pick Result')).toBeTruthy());
    expect(screen.getAllByText('Dune').length).toBeGreaterThan(0);
  });

  it('marks the drawn book as picked and shows the session counter', async () => {
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(useRandomPickStore.getState().pickCount).toBe(1));
    expect(useRandomPickStore.getState().pickedHashes.has('dune')).toBe(true);
  });

  it('reports exhaustion once every candidate has been drawn', async () => {
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(screen.getByText('Spin Again')).toBeTruthy());
    fireEvent.click(screen.getByText('Spin Again'));
    await waitFor(() =>
      expect(screen.getByText('All candidate books have been picked')).toBeTruthy(),
    );
  });

  it('hands the drawn book to onOpenBook when starting reading', async () => {
    const onOpenBook = vi.fn();
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={onOpenBook} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(screen.getByText('Start Reading')).toBeTruthy());
    fireEvent.click(screen.getByText('Start Reading'));
    expect(onOpenBook).toHaveBeenCalledWith(expect.objectContaining({ hash: 'dune' }));
  });

  it('clears the picked list on reset and allows spinning again', async () => {
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(screen.getByText('Reset Picked')).toBeTruthy());
    fireEvent.click(screen.getByText('Reset Picked'));
    expect(useRandomPickStore.getState().pickCount).toBe(0);
    expect(useRandomPickStore.getState().pickedHashes.size).toBe(0);
  });

  it('narrows the candidate pool when a group is added to the include list', async () => {
    setLibrary([dune, makeBook({ hash: 'cosmos', title: 'Cosmos', groupName: '科学' })]);
    useLibraryStore.setState({ groups: { 'id-science': '科学' } });
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    expect(screen.getByText(/Candidate Pool: 2 of 2/)).toBeTruthy();

    fireEvent.click(screen.getAllByText('Add Group')[0]!);
    fireEvent.click(screen.getByText('科学'));
    await waitFor(() => expect(screen.getByText(/Candidate Pool: 1 of 2/)).toBeTruthy());
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/__tests__/components/RandomPickDialog.test.tsx`
预期：FAIL，报错 `Failed to resolve import "@/app/library/components/randompick/RandomPickDialog"`

- [ ] **步骤 3：实现 `RandomPickDialog.tsx`**

创建 `src/app/library/components/randompick/RandomPickDialog.tsx`：

```tsx
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
} from '../utils/randomPickUtils';
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
                  (pickCount > 0
                    ? _('Picked this session: {{count}}', { count: pickCount })
                    : '')}
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
                <button type='button' className='btn btn-ghost btn-sm shrink-0' onClick={handleSkip}>
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/__tests__/components/RandomPickDialog.test.tsx`
预期：PASS，7 个用例通过

若「Candidate Pool: N of M」断言失败，说明 i18next 没有对 `defaultValue` 做插值。此时把 `poolSummary` 改成手写模板字符串（`${_('Candidate Pool')}: ${available} / ${total}`）并同步放宽该断言。

- [ ] **步骤 5：Commit**

```bash
cd apps/readest-app
git add src/app/library/components/randompick/RandomPickDialog.tsx src/__tests__/components/RandomPickDialog.test.tsx
git commit -m "feat(library): random pick dialog orchestration"
```

---

## 任务 8：书架接线与文案

**文件：**
- 修改：`src/app/library/components/LibraryHeader.tsx`
- 修改：`src/app/library/page.tsx`
- 修改：`public/locales/zh-CN/translation.json`
- 测试：`src/__tests__/components/LibraryHeader.test.tsx`

入口按钮按 TDD 走（步骤 1-4）；书架页接线部分是纯胶水，以类型检查 + 手工点击验证为准（步骤 6、8）。

- [ ] **步骤 1：编写入口按钮的组件测试**

创建 `src/__tests__/components/LibraryHeader.test.tsx`：

```tsx
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run src/__tests__/components/LibraryHeader.test.tsx`
预期：FAIL，报错 `Unable to find a label with the text of: Random Pick`（按钮尚未加入）

- [ ] **步骤 3：给工具栏加入口按钮**

在 `src/app/library/components/LibraryHeader.tsx` 中：

1. 顶部图标导入处新增 `import { FaDice } from 'react-icons/fa';`
2. `interface LibraryHeaderProps` 中新增一行：

```ts
  onOpenRandomPick: () => void;
```

3. 组件解构参数中新增 `onOpenRandomPick,`
4. 在动作区找到 `{searchTarget !== 'text' && (` 分支里的分隔线与 `Import Books` 下拉之间，插入：

```tsx
                <button
                  type='button'
                  onClick={onOpenRandomPick}
                  aria-label={_('Random Pick')}
                  title={_('Random Pick')}
                  className='exclude-title-bar-mousedown h-6'
                >
                  <FaDice role='button' className='text-base-content/60 h-5 w-5' />
                </button>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run src/__tests__/components/LibraryHeader.test.tsx`
预期：PASS，2 个用例通过

- [ ] **步骤 5：在书架页接线弹窗**

在 `src/app/library/page.tsx` 中：

1. 导入区新增（放在其他 `./components/...` 导入附近）：

```ts
import useOpenBook from '@/app/library/hooks/useOpenBook';
import RandomPickDialog from './components/randompick/RandomPickDialog';
```

2. 与其他 `show*` state（`showFeeds` / `showWebSources` / `showImportNovel` 所在区块）并列新增：

```ts
  const [showRandomPick, setShowRandomPick] = useState(false);
```

3. 在 `const { handleBookUpload, handleBookDownload } = useBookTransferActions(...)` 之后新增（必须在 `handleBookDownload` 定义之后、任何 early return 之前）：

```ts
  const { openBook } = useOpenBook({ setLoading, handleBookDownload });
```

4. 在 `<LibraryHeader ... />` 的 props 中，`onOpenFeeds={handleShowFeeds}` 之后新增：

```tsx
          onOpenRandomPick={() => setShowRandomPick(true)}
```

5. 在 `<ModalPortal><TransferQueuePanel /></ModalPortal>` 那一块的后面新增：

```tsx
      {showRandomPick && (
        <ModalPortal showOverlay={false}>
          <RandomPickDialog
            onClose={() => setShowRandomPick(false)}
            onOpenBook={(book) => {
              // 先关弹窗再进阅读器：openBook 对不可用的书会提示并停留在书架，
              // 此时留着弹窗会挡住提示。
              setShowRandomPick(false);
              void openBook(book);
            }}
          />
        </ModalPortal>
      )}
```

- [ ] **步骤 6：类型检查**

运行：`pnpm exec tsc --noEmit`
预期：无错误。若 `useOpenBook` 的 `handleBookDownload` 形参类型不匹配，核对 `src/app/library/hooks/useOpenBook.ts` 的 `UseOpenBookOptions`，以页面里 `handleBookDownload` 的实际签名为准调整调用处。

- [ ] **步骤 7：补中文文案**

**不运行** `pnpm i18n:extract`：它会重写全部 70 个 locale 文件，在自托管分支上产生大量无意义 diff。本仓库的约定是「英文原文即 key」，未翻译的语言自动回退显示英文，因此只需手工补中文。

在 `public/locales/zh-CN/translation.json` 中新增下列条目（保持文件按 key 排序的现有风格，未排序则追加到文件末尾前的合适位置）：

```json
  "Random Pick": "随机选书",
  "Start Random Pick": "开始随机",
  "Only pick from these groups": "只在以下分组中随机",
  "Exclude these groups": "排除以下分组",
  "Add Group": "添加分组",
  "Open Folder": "展开分组",
  "No Groups": "暂无分组",
  "All Books": "全部书籍",
  "Excluded Books": "排除的书籍",
  "Search and exclude books": "搜索并排除书籍",
  "No books match": "没有匹配的书籍",
  "Avoid repeats in this session": "本次会话不重复",
  "Skip Animation": "跳过动画",
  "Skip": "跳过",
  "Candidate Pool: {{available}} of {{total}}": "候选池：{{available}} / {{total}}",
  "Candidate Pool: {{available}} of {{total}} · {{excluded}} excluded": "候选池：{{available}} / {{total}} · 已排除 {{excluded}}",
  "No books match the current filters": "当前筛选没有可选书籍",
  "All candidate books have been picked": "候选池里的书都已经抽过了",
  "Reset Picked": "重置已抽记录",
  "Picked this session: {{count}}": "本次已抽 {{count}} 本",
  "Pick Result": "抽中了",
  "Spin Again": "再抽一次",
  "Start Reading": "开始阅读",
  "Restore Defaults": "恢复默认",
  "{{count}}% read": "已读 {{count}}%",
  "Remove": "移除"
```

注意 `Finished` / `Unread` / `Reading` / `On hold` 已存在于该文件，不要重复添加。

用 `node -e "JSON.parse(require('fs').readFileSync('public/locales/zh-CN/translation.json','utf8'))"` 校验 JSON 仍然合法。

- [ ] **步骤 8：手工验证入口**

运行：`pnpm dev`
在书架页确认：

1. 顶部工具栏出现骰子按钮，悬停显示「随机选书」。
2. 点击后弹窗打开，左栏筛选面板与右栏滚轮都在。
3. 点「开始随机」→ 滚轮滚动约 2.2 秒后停在结果卡片；点卡片上的「开始阅读」能进入阅读器。
4. 点击滚轮区域可在动画中途直接结算。
5. 关掉弹窗重开，上次的筛选条件仍然保留。

- [ ] **步骤 9：Commit**

```bash
cd apps/readest-app
git add src/app/library/components/LibraryHeader.tsx src/app/library/page.tsx public/locales/zh-CN/translation.json src/__tests__/components/LibraryHeader.test.tsx
git commit -m "feat(library): wire random pick entry into the bookshelf"
```

---

## 任务 9：全量校验与 Windows 安装包

**文件：** 无源码改动（仅产物）

- [ ] **步骤 1：跑全部新增测试**

运行：

```bash
cd apps/readest-app
pnpm vitest run src/__tests__/utils/random-pick-utils.test.ts src/__tests__/store/random-pick-store.test.ts src/__tests__/components/CoverCarousel.test.tsx src/__tests__/components/GroupMultiPicker.test.tsx src/__tests__/components/RandomPickResultCard.test.tsx src/__tests__/components/RandomPickFilters.test.tsx src/__tests__/components/RandomPickDialog.test.tsx src/__tests__/components/LibraryHeader.test.tsx
```

预期：8 个测试文件全绿。

- [ ] **步骤 2：跑回归测试**

运行：`pnpm vitest run src/__tests__/utils/library-utils.test.ts src/__tests__/store/library-store.test.ts src/__tests__/components/BookCover.test.tsx src/__tests__/components/BookDetailModal.test.tsx`
预期：全绿。改动只新增了文件与两个 `SystemSettings` 字段，不应影响既有行为。

- [ ] **步骤 3：类型检查与 lint**

运行：`pnpm lint`
预期：`tsc --noEmit` 与 `biome lint .` 均无错误。

若 biome 报 `noUnusedVariables`，检查各组件是否漏用了导入。

- [ ] **步骤 4：确认打包前置条件**

运行：

```bash
cd apps/readest-app
ls -la .env.tauri.local .env.server
```

预期：两个文件都存在（已确认存在于当前工作区）。若缺失，先 `cp .env.server.example .env.server` 并填写。

- [ ] **步骤 5：构建 Windows 安装包**

运行：`pnpm build-server-win-x64-64bit`

该脚本展开为 `dotenv -e .env.tauri.local -e .env.server -- tauri build --target x86_64-pc-windows-msvc --bundles nsis`；`beforeBuildCommand` 会带 `.env.server` 执行 `next build --webpack`，因此 `NEXT_PUBLIC_SELFHOSTED=1` 会参与构建。

预期：构建成功，无 TS/Rust 错误。首次构建耗时较长（前端 + Rust 编译）。

- [ ] **步骤 6：确认产物**

运行：

```bash
ls -la src-tauri/target/release/bundle/nsis/
```

预期：出现 `Readest_<version>_x64-setup.exe`。

- [ ] **步骤 7：安装后的手工验收**

安装 `.exe` 后逐项确认：

1. 书架顶部有骰子入口，点击能打开随机选书弹窗。
2. 勾选一个分组进白名单，候选池数字随之下降到该分组的书目数。
3. 把同一分组加入黑名单，候选池归零，「开始随机」变灰并提示「当前筛选没有可选书籍」。
4. 清空筛选后点「开始随机」，滚轮滚动并停在一本书上，弹出结果卡片。
5. 点「再抽一次」不会抽到刚抽中的那本；重复抽到候选池抽空后提示「候选池里的书都已经抽过了」。
6. 点「开始阅读」能正常进入阅读器；若该书是云同步书籍，会先按需下载。
7. 关闭并重启应用，之前的筛选条件仍在；「本次已抽」计数归零（会话级状态）。

- [ ] **步骤 8：Commit（如有构建期产生的必要改动）**

```bash
cd apps/readest-app
git status --short
```

只提交源码相关改动；`src-tauri/target/` 与 `gen/` 下的构建产物不属于本次改动范围，不要一并提交。

---

## 完成标准

- [ ] 8 个新增测试文件全部通过
- [ ] `pnpm lint` 干净
- [ ] 手工验收 7 项全部通过
- [ ] `Readest_<version>_x64-setup.exe` 产出并安装验证通过

---

## 备注：与规格的两处偏差

1. **弹窗打开书籍的方式**：规格 4.7 写的是「`onOpenBook` 复用页面已有的 `openBook`」，但书架页原本并没有 `useOpenBook` 实例（它只存在于 `Bookshelf` / `BookshelfItem` 内部）。实现时由页面自己调用 `useOpenBook({ setLoading, handleBookDownload })` 取得 `openBook` 并注入弹窗，保持了弹窗 API 的纯粹（`onOpenBook: (book: Book) => void`），也复用了按需下载与失效文件清理的既有逻辑。
2. **文案提取**：规格 5 写的是「运行 `pnpm i18n:extract`」。实测该命令会重写全部 70 个 locale 文件，在自托管分支上产生与功能无关的大量 diff；由于本仓库采用「英文原文即 key、未翻译回退英文」的约定，改为只手工补 `zh-CN`。若上游后续要求 key 登记，再单独跑一次提取即可。


