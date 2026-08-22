import { describe, expect, it } from 'vitest';
import { bookMetadataChanged, resolveMetadataMerge } from '@/pages/api/sync';

const iso = (ms: number) => new Date(ms).toISOString();

type MetadataFields = Parameters<typeof resolveMetadataMerge>[0] & {
  pinned_at?: string | null;
};

const baseFields: MetadataFields = {
  title: 'Shared Title',
  author: 'Shared Author',
  tags: ['news'],
  metadata: '{"language":"sv"}',
  metadata_updated_at: null,
  pinned_at: null,
};

const withFields = (overrides: Partial<MetadataFields>): MetadataFields => ({
  ...baseFields,
  ...overrides,
});

describe('resolveMetadataMerge (issue #5438)', () => {
  it('keeps the client metadata when its metadata_updated_at is newer', () => {
    const out = resolveMetadataMerge(
      withFields({ metadata_updated_at: iso(200) }),
      withFields({ metadata_updated_at: iso(100) }),
      false,
    );
    expect(out).toEqual(withFields({ metadata_updated_at: iso(200) }));
  });

  it('keeps the server metadata when its stamp is newer, even when the client wins the row', () => {
    // The reported clobber: another device turns a page (newer updated_at,
    // stale metadata) after this metadata was edited. The row goes to the
    // client, but the metadata edit must survive.
    const out = resolveMetadataMerge(
      withFields({ metadata_updated_at: iso(100) }),
      withFields({ metadata_updated_at: iso(300) }),
      true,
    );
    expect(out).toEqual(withFields({ metadata_updated_at: iso(300) }));
  });

  it('falls back to the row winner when neither side is stamped (legacy rows)', () => {
    expect(resolveMetadataMerge(baseFields, baseFields, true)).toEqual(baseFields);
    expect(resolveMetadataMerge(baseFields, baseFields, false)).toEqual(baseFields);
  });

  it('keeps pinned_at when the metadata winner is materialized as a row', () => {
    const client = withFields({ metadata_updated_at: iso(100), pinned_at: iso(100) });
    const server = withFields({ metadata_updated_at: iso(200), pinned_at: iso(200) });

    expect(resolveMetadataMerge(client, server, true)).toEqual(server);
    expect(resolveMetadataMerge(client, server, false)).toEqual(server);
  });
});

describe('bookMetadataChanged', () => {
  it('false when every field matches (no propagation churn)', () => {
    expect(bookMetadataChanged(baseFields, { ...baseFields })).toBe(false);
  });

  it('treats undefined and null metadata/tags as equal', () => {
    expect(
      bookMetadataChanged(
        { title: 'T', author: 'A', tags: undefined, metadata: undefined },
        { title: 'T', author: 'A', tags: undefined, metadata: null },
      ),
    ).toBe(false);
  });

  it('treats pinned_at as part of the metadata group', () => {
    const client = withFields({ pinned_at: iso(100) });
    const server = withFields({ pinned_at: null });

    expect(bookMetadataChanged(client, server)).toBe(true);
    expect(bookMetadataChanged(server, client)).toBe(true);
  });

  it('true when only tags differ', () => {
    expect(bookMetadataChanged(withFields({ tags: ['other'] }), baseFields)).toBe(true);
  });
});
