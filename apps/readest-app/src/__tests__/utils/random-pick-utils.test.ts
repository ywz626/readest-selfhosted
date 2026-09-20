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
    expect(
      normalizeRandomPickRules({ includeGroups: ['a', 'a', '', 3, null] }).includeGroups,
    ).toEqual(['a']);
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
