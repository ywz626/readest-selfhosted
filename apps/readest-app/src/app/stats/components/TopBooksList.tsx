import clsx from 'clsx';
import { useTranslation } from '@/hooks/useTranslation';
import { formatReadingDuration } from '@/utils/time';
import type { StatBookTotals } from '@/types/statistics';

interface TopBooksListProps {
  books: StatBookTotals[];
}

/** Top-10 ranking by per-book reading time, with relative proportion bars. */
const TopBooksList: React.FC<TopBooksListProps> = ({ books }) => {
  const _ = useTranslation();
  if (books.length === 0) return null;
  const top = books[0]!.totalReadTime;

  return (
    <section aria-label={_('Top 10 Books')} className='flex flex-col gap-3'>
      <h2 className='text-base-content text-base font-semibold'>{_('Top 10 Books')}</h2>
      <ol className='flex flex-col'>
        {books.map((book, index) => (
          <li
            key={book.bookMd5}
            className='border-base-200/60 flex items-center gap-3 border-b py-2.5 last:border-b-0'
          >
            <span
              className={clsx(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                index < 3 ? 'bg-primary text-primary-content' : 'bg-base-200 text-neutral-content',
              )}
            >
              {index + 1}
            </span>
            <div className='min-w-0 flex-1'>
              <div className='flex items-baseline justify-between gap-3'>
                <span className='text-base-content truncate text-sm font-medium'>
                  {book.title || book.bookMd5}
                </span>
                <span className='text-neutral-content shrink-0 text-xs'>
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
                  <span className='text-neutral-content/70 w-24 shrink-0 truncate text-xs'>
                    {book.authors}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
};

export default TopBooksList;
