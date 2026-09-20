import { DEFAULT_RANDOM_PICK_RULES } from '@/services/constants';
import { Book } from '@/types/book';
import { RandomPickRules } from '@/types/settings';

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
 * 老版本 settings.json 里的 randomPickRules 可能缺失或残缺。
 */
export const normalizeRandomPickRules = (raw: unknown): RandomPickRules => {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    // 索引签名下的属性必须用中括号访问（tsconfig 打开了
    // noPropertyAccessFromIndexSignature）
    includeGroups: toStringList(source['includeGroups']),
    excludeGroups: toStringList(source['excludeGroups']),
    excludeBooks: toStringList(source['excludeBooks']),
    avoidRepeats: toBoolean(source['avoidRepeats'], DEFAULT_RANDOM_PICK_RULES.avoidRepeats),
    skipAnimation: toBoolean(source['skipAnimation'], DEFAULT_RANDOM_PICK_RULES.skipAnimation),
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
    (book) => !excludedHashes.has(book.hash) && !groupMatches(book.groupName ?? '', excludeGroups),
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
