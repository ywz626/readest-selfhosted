-- Migration 019: Add `pinned_at` to books
--
-- Reading-library pinning. Pinning a book lifts it to the top of its parent
-- folder; multiple pins order among themselves by the active library sort.
--
--   pinned_at = epoch-ms pin timestamp stored as `timestamptz`. NULL = not
--               pinned. Rides the whole book row's updated_at LWW clock like
--               group membership (#4942): pinning/unpinning bumps updated_at,
--               so the fresher row propagates the pin to every peer, and an
--               unpin (NULL) clears it there.
--
-- Additive + nullable; old clients ignore the column, so they never break.

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS pinned_at timestamp with time zone NULL;