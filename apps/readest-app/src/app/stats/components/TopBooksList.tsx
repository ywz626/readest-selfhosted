import clsx from 'clsx';
import { useTranslation } from '@/hooks/useTranslation';
import { formatReadingDuration } from '@/utils/time';
import type { StatBookTotals } from '@/types/statistics';

interface TopBooksListProps {
  books: StatBookTotals[];
  /** Optional custom heading (e.g. "8月12日 · Top 10 Books"). Defaults to a translated one. */
  title?: string;
  /** Opens the tapped book in the reader. Rows stay inert without it. */
  onSelectBook?: (book: StatBookTotals) => void;
  /** Hash of the row currently being opened (download + navigation in flight). */
  pendingHash?: string | null;
}

/** Top-10 ranking by per-book reading time, with relative proportion bars. */
const TopBooksList: React.FC<TopBooksListProps> = ({ books, title, onSelectBook, pendingHash }) => {
  const _ = useTranslation();
  const heading = title ?? _('Top 10 Books');

  // A drill-down into a day with no reading activity leaves the ranking empty;
  // it still has to announce itself instead of vanishing under the chart.
  if (books.length === 0) {
    return (
      <section aria-label={heading} className='flex flex-col gap-4'>
        <h2 className='text-base-content text-base font-semibold'>{heading}</h2>
        <p className='text-neutral-content text-sm'>{_('No reading data yet')}</p>
      </section>
    );
  }

  // Guard the proportion bars against a 0-second leader, which would divide by
  // zero and hand `width` an invalid `NaN%`.
  const top = Math.max(1, books[0]!.totalReadTime);

  return (
    <section aria-label={heading} className='flex flex-col gap-4'>
      <h2 className='text-base-content text-base font-semibold'>{heading}</h2>
      <ol className='flex flex-col'>
        {books.map((book, index) => {
          const isPending = pendingHash === book.bookMd5;
          return (
            <li key={book.bookMd5} className='border-base-200/60 border-b last:border-b-0'>
              <button
                type='button'
                onClick={() => onSelectBook?.(book)}
                disabled={!onSelectBook || isPending}
                aria-busy={isPending || undefined}
                className={clsx(
                  'flex w-full items-center gap-3 rounded-lg py-3 text-left',
                  onSelectBook &&
                    !isPending &&
                    'hover:bg-base-200/50 cursor-pointer transition-colors',
                )}
              >
                <span
                  className={clsx(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    index < 3
                      ? 'bg-primary text-primary-content'
                      : 'bg-base-200 text-neutral-content',
                  )}
                >
                  {index + 1}
                </span>
                <div className='min-w-0 flex-1'>
                  <div className='flex items-baseline justify-between gap-3'>
                    <span className='text-base-content truncate text-sm font-medium'>
                      {book.title || book.bookMd5}
                    </span>
                    <span className='text-neutral-content flex shrink-0 items-center gap-1 text-xs'>
                      {isPending && <span className='loading loading-spinner loading-xs' />}
                      {formatReadingDuration(book.totalReadTime, _)}
                    </span>
                  </div>
                  <div className='mt-1 flex items-center gap-2'>
                    <div className='h-1 max-w-48 flex-1 overflow-hidden rounded-full bg-base-200'>
                      <div
                        className='bg-primary/60 h-full rounded-full'
                        style={{ width: `${Math.max(3, (book.totalReadTime / top) * 100)}%` }}
                      />
                    </div>
                    {book.authors && (
                      <span className='text-neutral-content/70 w-20 shrink-0 truncate text-xs sm:w-24'>
                        {book.authors}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

export default TopBooksList;
