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
