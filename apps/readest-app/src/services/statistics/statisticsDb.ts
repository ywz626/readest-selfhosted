import type { AppService } from '@/types/system';
import type { DatabaseService, DatabaseRow } from '@/types/database';
import {
  DEFAULT_STATS_TRACKING_CONFIG,
  DailyReadTime,
  MonthlyReadTime,
  PageStatEvent,
  ReadingOverview,
  StatBook,
  StatBookTotals,
} from '@/types/statistics';

interface BookRow extends DatabaseRow {
  id: number;
  title: string;
  authors: string;
  md5: string;
  total_read_time: number;
  total_read_pages: number;
  last_open: number;
  pages: number;
}

type CursorKey = 'push' | 'pull' | 'bookorbit-push';

// Readest caps one page visit at this, so a longer event spans several pages
// (a CrossPoint session recorded in whole percents) and says nothing about pace.
const MAX_PAGE_SECONDS = DEFAULT_STATS_TRACKING_CONFIG.maxEventSeconds;

/**
 * Per-tab singleton open promise. OPFS permits only ONE access handle per file
 * across the whole origin, so a second `connect()` to statistics.db throws
 * `NoModificationAllowedError`. Every ReadingStatsTracker instance (and split-
 * view books) must therefore share a single connection — we memoise the open
 * and never thrash it.
 */
let sharedDb: Promise<StatisticsDb> | null = null;
let lifecycleBound = false;

function bindLifecycle(): void {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  // Fold the WAL into the main db when the tab is backgrounded/closed — the
  // most reliable point for best-effort async OPFS work before teardown.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && sharedDb) {
      void sharedDb.then((s) => s.checkpoint()).catch(() => {});
    }
  });
}

/**
 * Typed wrapper over the KOReader-compatible `statistics.db`. All identity is
 * keyed on `book_hash` (= Book.hash); the local autoincrement `id_book` never
 * leaves this class.
 */
export class StatisticsDb {
  // Serializes applyRemoteEvents so two concurrent pulls can't nest BEGINs.
  private applyRemoteLock: Promise<void> = Promise.resolve();

  private constructor(private readonly db: DatabaseService) {}

  /** Production entry point — opens + migrates statistics.db (per-tab singleton). */
  static async open(appService: AppService): Promise<StatisticsDb> {
    bindLifecycle();
    if (!sharedDb) {
      const opening = (async () => {
        const db = await appService.openDatabase('statistics', 'statistics.db', 'Data');
        return new StatisticsDb(db);
      })();
      sharedDb = opening;
      void opening.catch(() => {
        if (sharedDb === opening) sharedDb = null;
      });
    }
    return sharedDb;
  }

  /** Test/advanced entry point — wrap an already-migrated DatabaseService. */
  static from(db: DatabaseService): StatisticsDb {
    return new StatisticsDb(db);
  }

  /**
   * Fold the WAL into the main db file and truncate it. The Turso engine does
   * NOT implement `PRAGMA wal_autocheckpoint` (so there's no auto threshold to
   * rely on), but `wal_checkpoint(TRUNCATE)` works — verified folding a 688 KB
   * WAL back to 0 B. We call this when the tab is hidden so the WAL stays bounded.
   */
  async checkpoint(): Promise<void> {
    await this.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** Checkpoint, close the underlying connection, and reset the singleton. */
  async close(): Promise<void> {
    try {
      await this.checkpoint();
    } catch {
      // best-effort — a checkpoint failure must not block close
    }
    await this.db.close();
    sharedDb = null;
  }

  async upsertBook(book: StatBook): Promise<number> {
    const existing = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      book.bookMd5,
    ]);
    if (existing[0]) {
      // md5 is the identity; keep the latest title/authors (LWW, matches server stat_books).
      await this.db.execute(`UPDATE book SET title = ?, authors = ? WHERE id = ?`, [
        book.title,
        book.authors,
        existing[0].id,
      ]);
      return existing[0].id;
    }
    await this.db.execute(
      `INSERT INTO book (title, authors, md5, notes, last_open, highlights, pages, total_read_time, total_read_pages)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)
       ON CONFLICT(title, authors, md5) DO NOTHING`,
      [book.title, book.authors, book.bookMd5],
    );
    const rows = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      book.bookMd5,
    ]);
    return rows[0]!.id;
  }

  async insertPageEvent(
    idBook: number,
    e: { page: number; startTime: number; duration: number; totalPages: number },
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id_book, page, start_time)
       DO UPDATE SET duration = max(duration, excluded.duration), total_pages = excluded.total_pages`,
      [idBook, e.page, e.startTime, e.duration, e.totalPages],
    );
  }

  async recomputeBookTotals(idBook: number): Promise<void> {
    await this.db.execute(
      `UPDATE book SET
         total_read_time  = COALESCE((SELECT SUM(duration) FROM page_stat_data WHERE id_book = ?), 0),
         total_read_pages = COALESCE((SELECT COUNT(DISTINCT page) FROM page_stat_data WHERE id_book = ?), 0),
         last_open        = COALESCE((SELECT MAX(start_time + duration) FROM page_stat_data WHERE id_book = ?), last_open),
         pages            = COALESCE((SELECT total_pages FROM page_stat_data WHERE id_book = ? ORDER BY start_time DESC LIMIT 1), pages)
       WHERE id = ?`,
      [idBook, idBook, idBook, idBook, idBook],
    );
  }

  /**
   * Returns the median duration of time spent on each page in seconds. Returns
   * `null` if sufficient data is not available.
   *
   * Use the median since reading times are skewed; thus the median must be
   * used to get the middle value.
   */
  async getMedianPageDurationSecs(idBook: number): Promise<number | null> {
    const PAGE_THRESHOLD = 5;
    const rows = await this.db.select<{ duration: number }>(
      `SELECT duration
         FROM page_stat_data
         WHERE id_book = ? AND duration <= ?
         ORDER BY start_time DESC, page DESC
         LIMIT 50`,
      [idBook, MAX_PAGE_SECONDS],
    );
    if (rows.length < PAGE_THRESHOLD) return null;
    // The query orders by recency; sort by value so the middle is the true median.
    const pageDurations = rows.map((d) => d['duration']).sort((a, b) => a - b);
    const mid = Math.floor(pageDurations.length / 2);
    return pageDurations.length % 2 !== 0
      ? (pageDurations[mid] ?? 0)
      : ((pageDurations[mid - 1] ?? 0) + (pageDurations[mid] ?? 0)) / 2;
  }

  /** Load shelf paces in one query, using the same last-50 sample as book labels. */
  async getMedianPageDurationsSecs(): Promise<Record<string, number>> {
    const rows = await this.db.select<{ md5: string; duration: number }>(
      `SELECT md5, duration FROM (
         SELECT b.md5, p.duration,
           ROW_NUMBER() OVER (PARTITION BY p.id_book ORDER BY p.start_time DESC, p.page DESC) AS recency
         FROM page_stat_data p JOIN book b ON b.id = p.id_book
         WHERE p.duration <= ?
       ) WHERE recency <= 50 ORDER BY md5, duration`,
      [MAX_PAGE_SECONDS],
    );
    const samples = new Map<string, number[]>();
    for (const { md5, duration } of rows) {
      const durations = samples.get(md5) ?? [];
      durations.push(duration);
      samples.set(md5, durations);
    }
    const medians: Record<string, number> = {};
    for (const [md5, durations] of samples) {
      if (durations.length < 5) continue;
      const mid = Math.floor(durations.length / 2);
      medians[md5] =
        durations.length % 2 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2;
    }
    return medians;
  }

  /**
   * Seconds read in each quarter hour (`start_time / 900`). Every UTC offset is
   * a multiple of 15 minutes, so callers can fold these into local days in JS
   * instead of trusting SQL `localtime` to know the host's time zone.
   */
  async getQuarterHourDurations(): Promise<{ quarter: number; seconds: number }[]> {
    return this.db.select<{ quarter: number; seconds: number }>(
      `SELECT start_time / 900 AS quarter, SUM(duration) AS seconds
       FROM page_stat_data GROUP BY quarter ORDER BY quarter`,
    );
  }

  async getReadingTotals(): Promise<{ seconds: number; books: number; pages: number }> {
    const rows = await this.db.select<{ seconds: number; books: number; pages: number }>(
      `SELECT COALESCE(SUM(duration), 0) AS seconds,
              COUNT(DISTINCT id_book) AS books,
              COUNT(DISTINCT id_book || '-' || page) AS pages
       FROM page_stat_data`,
    );
    return rows[0] ?? { seconds: 0, books: 0, pages: 0 };
  }

  async getBookByMd5(md5: string): Promise<BookRow | null> {
    const rows = await this.db.select<BookRow>(`SELECT * FROM book WHERE md5 = ? LIMIT 1`, [md5]);
    return rows[0] ?? null;
  }

  /**
   * Ensure a book row exists for an event whose metadata record isn't in the
   * current batch (paged pull can deliver an event before its `stat_books`
   * record). Unlike `upsertBook`, this NEVER overwrites an existing real title
   * with the hash placeholder — the real record, arriving in any page, wins.
   */
  private async ensureBookId(bookMd5: string): Promise<number> {
    const existing = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      bookMd5,
    ]);
    if (existing[0]) return existing[0].id;
    return this.upsertBook({ bookMd5, title: bookMd5, authors: '' });
  }

  /** Events with start_time > cursor, joined to their md5, for pushing. */
  async getEventsForPush(
    sinceStartTime: number,
  ): Promise<{ events: PageStatEvent[]; books: StatBook[] }> {
    const rows = await this.db.select<DatabaseRow>(
      `SELECT b.md5 AS bookMd5, b.title AS title, b.authors AS authors,
              p.page AS page, p.start_time AS startTime, p.duration AS duration, p.total_pages AS totalPages
       FROM page_stat_data p JOIN book b ON b.id = p.id_book
       WHERE p.start_time > ?
       ORDER BY p.start_time ASC`,
      [sinceStartTime],
    );
    const events: PageStatEvent[] = rows.map((r) => ({
      bookMd5: String(r['bookMd5']),
      page: Number(r['page']),
      startTime: Number(r['startTime']),
      duration: Number(r['duration']),
      totalPages: Number(r['totalPages']),
    }));
    const bookMap = new Map<string, StatBook>();
    for (const r of rows) {
      const md5 = String(r['bookMd5']);
      if (!bookMap.has(md5)) {
        bookMap.set(md5, {
          bookMd5: md5,
          title: String(r['title']),
          authors: String(r['authors']),
        });
      }
    }
    return { events, books: [...bookMap.values()] };
  }

  async applyRemoteEvents(books: StatBook[], events: PageStatEvent[]): Promise<void> {
    if (books.length === 0 && events.length === 0) return;
    // Serialize against other pulls: the statistics connection is shared across
    // ReadingStatsTracker instances (split view), and a second concurrent pull
    // would open a BEGIN inside this one's still-open BEGIN ("cannot start a
    // transaction within a transaction", Sentry READEST-N). The per-op native
    // lock can't make this multi-statement transaction atomic on its own.
    const prev = this.applyRemoteLock;
    let release!: () => void;
    this.applyRemoteLock = new Promise<void>((resolve) => (release = resolve));
    await prev;
    try {
      // One transaction for the whole pulled batch: a single commit instead of
      // O(rows) fsyncs, and the apply is atomic (a failed pull leaves no partial
      // state). Critical when a fresh device backfills tens of thousands of rows.
      await this.db.execute('BEGIN');
      try {
        const idByMd5 = new Map<string, number>();
        for (const b of books) idByMd5.set(b.bookMd5, await this.upsertBook(b));
        // Books referenced only by events (no metadata record) get a placeholder row.
        const touched = new Set<number>();
        for (const e of events) {
          let id = idByMd5.get(e.bookMd5);
          if (id === undefined) {
            id = await this.ensureBookId(e.bookMd5);
            idByMd5.set(e.bookMd5, id);
          }
          await this.insertPageEvent(id, e);
          touched.add(id);
        }
        for (const id of touched) await this.recomputeBookTotals(id);
        await this.db.execute('COMMIT');
      } catch (err) {
        await this.db.execute('ROLLBACK');
        throw err;
      }
    } finally {
      release();
    }
  }

  /**
   * Account-wide aggregates for the reading-stats page. Buckets use the
   * device's local timezone: SQLite's `localtime` modifier can't be trusted
   * across the WASM/native engine split, so the offset is applied explicitly
   * as a parameter (DST edge days landing in the neighbouring month are a
   * tolerable approximation).
   */
  async getReadingOverview(): Promise<ReadingOverview> {
    const offset = -new Date().getTimezoneOffset() * 60;
    const rows = await this.db.select<DatabaseRow>(
      `SELECT COALESCE(SUM(duration), 0) AS total,
              COUNT(DISTINCT date(start_time + ?, 'unixepoch')) AS days,
              COUNT(DISTINCT id_book) AS books
       FROM page_stat_data`,
      [offset],
    );
    const row = rows[0];
    return {
      totalReadSecs: Number(row?.['total'] ?? 0),
      readingDays: Number(row?.['days'] ?? 0),
      booksWithTime: Number(row?.['books'] ?? 0),
    };
  }

  /** Reading time bucketed by local-timezone year-month, ascending. */
  async getMonthlyReadTimes(): Promise<MonthlyReadTime[]> {
    const offset = -new Date().getTimezoneOffset() * 60;
    const rows = await this.db.select<DatabaseRow>(
      `SELECT strftime('%Y', start_time + ?, 'unixepoch') AS year,
              strftime('%m', start_time + ?, 'unixepoch') AS month,
              SUM(duration) AS duration
       FROM page_stat_data
       GROUP BY year, month
       ORDER BY year, month`,
      [offset, offset],
    );
    return rows.map((r) => ({
      year: Number(r['year']),
      month: Number(r['month']),
      durationSecs: Number(r['duration']),
    }));
  }

  /** Reading time bucketed by local-timezone year-month-day, ascending. */
  async getDailyReadTimes(): Promise<DailyReadTime[]> {
    const offset = -new Date().getTimezoneOffset() * 60;
    const rows = await this.db.select<DatabaseRow>(
      `SELECT strftime('%Y', start_time + ?, 'unixepoch') AS year,
              strftime('%m', start_time + ?, 'unixepoch') AS month,
              strftime('%d', start_time + ?, 'unixepoch') AS day,
              SUM(duration) AS duration
       FROM page_stat_data
       GROUP BY year, month, day
       ORDER BY year, month, day`,
      [offset, offset, offset],
    );
    return rows.map((r) => ({
      year: Number(r['year']),
      month: Number(r['month']),
      day: Number(r['day']),
      durationSecs: Number(r['duration']),
    }));
  }

  /** Books ranked by total reading time, descending. */
  async getTopBooksByReadTime(limit: number): Promise<StatBookTotals[]> {
    const rows = await this.db.select<BookRow>(
      `SELECT * FROM book
       WHERE total_read_time > 0
       ORDER BY total_read_time DESC, last_open DESC
       LIMIT ?`,
      [limit],
    );
    return rows.map((b) => ({
      bookMd5: b.md5,
      title: b.title,
      authors: b.authors,
      totalReadTime: b.total_read_time,
      totalReadPages: b.total_read_pages,
      lastOpen: b.last_open,
      pages: b.pages,
    }));
  }

  /**
   * Books ranked by reading time within a [fromSec, toSec] window,
   * descending. Falls back to the all-time ranking when `fromSec`
   * or `toSec` is null (called from the "total" tab).
   */
  async getTopBooksByReadTimeInRange(
    limit: number,
    fromSec: number | null,
    toSec: number | null,
  ): Promise<StatBookTotals[]> {
    if (fromSec === null || toSec === null) {
      return this.getTopBooksByReadTime(limit);
    }
    const rows = await this.db.select<DatabaseRow>(
      `SELECT b.md5 AS book_md5, b.title AS title, b.authors AS authors,
              SUM(p.duration) AS total_read_time,
              MAX(p.start_time) AS last_open
       FROM page_stat_data p
       JOIN book b ON b.id = p.id_book
       WHERE p.start_time >= ? AND p.start_time < ?
       GROUP BY p.id_book
       ORDER BY total_read_time DESC, last_open DESC
       LIMIT ?`,
      [fromSec, toSec, limit],
    );
    return rows.map((r) => ({
      bookMd5: String(r['book_md5'] ?? ''),
      title: String(r['title'] ?? ''),
      authors: String(r['authors'] ?? ''),
      totalReadTime: Number(r['total_read_time'] ?? 0),
      totalReadPages: 0,
      lastOpen: Number(r['last_open'] ?? 0),
      pages: 0,
    }));
  }

  async getCursor(key: CursorKey): Promise<number> {
    const rows = await this.db.select<{ value: number }>(
      `SELECT value FROM readest_stat_sync_state WHERE key = ?`,
      [key],
    );
    return rows[0]?.value ?? 0;
  }

  async setCursor(key: CursorKey, value: number): Promise<void> {
    await this.db.execute(
      `INSERT INTO readest_stat_sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}
