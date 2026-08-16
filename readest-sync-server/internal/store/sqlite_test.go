package store

import (
	"bytes"
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func intPtr(v int64) *int64 {
	return &v
}

func newTestStore(t *testing.T) *SqliteStore {
	t.Helper()
	s, err := NewSqliteStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.db.Close() })
	return s
}

func TestSqliteUpsertPullBook(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := int64(1000)
	b := BookRow{ID: "1", UserID: "owner", BookHash: "h1", UpdatedAt: &now, SyncedAt: "2024-01-01T00:00:00Z", Data: []byte(`{"id":"1"}`)}
	if err := s.UpsertBook(ctx, b); err != nil {
		t.Fatal(err)
	}
	rows, err := s.PullBooks(ctx, "owner", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 got %d", len(rows))
	}
}

func TestSqliteBookRowLevelLWW(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	newer := int64(2000)
	older := int64(1000)
	// First device pushes the newer row.
	if err := s.UpsertBook(ctx, BookRow{
		ID: "h1", UserID: "owner", BookHash: "h1", UpdatedAt: &newer, SyncedAt: "t1",
		Data: []byte(`{"book_hash":"h1","title":"New Title","created_at":"1970-01-01T00:00:02Z","updated_at":"1970-01-01T00:00:02Z"}`),
	}); err != nil {
		t.Fatal(err)
	}
	// A stale row with an older updated_at must not overwrite it.
	if err := s.UpsertBook(ctx, BookRow{
		ID: "h1", UserID: "owner", BookHash: "h1", UpdatedAt: &older, SyncedAt: "t2",
		Data: []byte(`{"book_hash":"h1","title":"Old Title","created_at":"1970-01-01T00:00:02Z","updated_at":"1970-01-01T00:00:01Z"}`),
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetBook(ctx, "owner", "h1")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("book not found")
	}
	if !bytes.Contains(got.Data, []byte("New Title")) {
		t.Fatalf("stale row overwrote newer row: %s", got.Data)
	}
}

func TestSqliteBookFieldLevelLWW(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	serverNewer := int64(3000)
	// Device A: server row is newer overall, but its metadata is stale.
	if err := s.UpsertBook(ctx, BookRow{
		ID: "h1", UserID: "owner", BookHash: "h1", UpdatedAt: &serverNewer, SyncedAt: "t1",
		Data: []byte(`{"book_hash":"h1","title":"Server Title","metadata":"{\"m\":\"old\"}","metadata_updated_at":"1970-01-01T00:00:01Z","updated_at":"1970-01-01T00:00:03Z"}`),
	}); err != nil {
		t.Fatal(err)
	}
	// Device B: older overall updated_at but newer metadata must be grafted.
	clientNewer := int64(1000)
	if err := s.UpsertBook(ctx, BookRow{
		ID: "h1", UserID: "owner", BookHash: "h1", UpdatedAt: &clientNewer, SyncedAt: "t2",
		Data: []byte(`{"book_hash":"h1","title":"Client Title","metadata":"{\"m\":\"new\"}","metadata_updated_at":"1970-01-01T00:00:02Z","updated_at":"1970-01-01T00:00:01Z"}`),
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetBook(ctx, "owner", "h1")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("book not found")
	}
	// Server title must be kept (client row lost at row level)...
	if !bytes.Contains(got.Data, []byte("Server Title")) {
		t.Fatalf("server title lost: %s", got.Data)
	}
	// ...but the newer client metadata must have been grafted. In the stored
	// JSON the metadata string is escaped: "metadata":"{\"m\":\"new\"}".
	if !bytes.Contains(got.Data, []byte(`{\"m\":\"new\"}`)) {
		t.Fatalf("client metadata was not grafted: %s", got.Data)
	}
}

func TestSqliteNoteDeletionPropagation(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	created := int64(1000)
	// Create the note.
	if err := s.UpsertNote(ctx, "owner", []byte(`{"id":"n1","book_hash":"h1","updated_at":1000}`)); err != nil {
		t.Fatal(err)
	}
	// Deleting a note only bumps deleted_at (updated_at stays at creation time),
	// mirroring the client's annotator behavior.
	if err := s.UpsertNote(ctx, "owner", []byte(`{"id":"n1","book_hash":"h1","updated_at":1000,"deleted_at":2000}`)); err != nil {
		t.Fatal(err)
	}
	rows, err := s.PullNotes(ctx, "owner", created)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("deleted note was not propagated: want 1 row got %d", len(rows))
	}
	if !bytes.Contains(rows[0], []byte(`"deleted_at":2000`)) {
		t.Fatalf("deleted_at missing from pulled note: %s", rows[0])
	}
	// An even older row must not resurrect the note.
	if err := s.UpsertNote(ctx, "owner", []byte(`{"id":"n1","book_hash":"h1","updated_at":500}`)); err != nil {
		t.Fatal(err)
	}
	rows, err = s.PullNotes(ctx, "owner", created)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("stale update resurrected a deleted note: %d rows", len(rows))
	}
}

func TestSqliteStatPagesDurationLWWAndSessions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	// Same session: the longer duration must win.
	if err := s.UpsertStatPages(ctx, []StatPageRow{
		{UserID: "owner", BookHash: "h1", Page: 1, StartTime: 1000, Duration: 100, TotalPages: 10, UpdatedAtMs: intPtr(1000)},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertStatPages(ctx, []StatPageRow{
		{UserID: "owner", BookHash: "h1", Page: 1, StartTime: 1000, Duration: 200, TotalPages: 10, UpdatedAtMs: intPtr(2000)},
	}); err != nil {
		t.Fatal(err)
	}
	// A shorter duration for the same session must not overwrite.
	if err := s.UpsertStatPages(ctx, []StatPageRow{
		{UserID: "owner", BookHash: "h1", Page: 1, StartTime: 1000, Duration: 50, TotalPages: 10, UpdatedAtMs: intPtr(3000)},
	}); err != nil {
		t.Fatal(err)
	}
	// A different session of the same page is a separate row.
	if err := s.UpsertStatPages(ctx, []StatPageRow{
		{UserID: "owner", BookHash: "h1", Page: 1, StartTime: 3000, Duration: 60, TotalPages: 10, UpdatedAtMs: intPtr(4000)},
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.PullStatPages(ctx, "owner", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 sessions got %d", len(rows))
	}
	found := false
	for _, r := range rows {
		if r.StartTime == 1000 && r.Duration == 200 {
			found = true
		}
	}
	if !found {
		t.Fatalf("longer duration did not win: %+v", rows)
	}
}

func TestSqliteStatPagesMigration(t *testing.T) {
	dir := t.TempDir()
	dsn := filepath.Join(dir, "test.db")
	raw, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	// Create the legacy schema: start_time NOT part of the primary key.
	if _, err := raw.Exec(`
		CREATE TABLE stat_pages (
			user_id TEXT, book_hash TEXT, page INTEGER, start_time INTEGER, duration INTEGER, total_pages INTEGER, updated_at_ms INTEGER, deleted_at INTEGER,
			PRIMARY KEY(user_id, book_hash, page)
		);
		INSERT INTO stat_pages VALUES ('owner','h1',1,1000,50,10,2000,NULL);
	`); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := NewSqliteStore(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.db.Close()
	ctx := context.Background()
	// After migration, two distinct sessions of the same page can coexist.
	if err := s.UpsertStatPages(ctx, []StatPageRow{
		{UserID: "owner", BookHash: "h1", Page: 1, StartTime: 100, Duration: 10, TotalPages: 10, UpdatedAtMs: intPtr(100)},
		{UserID: "owner", BookHash: "h1", Page: 1, StartTime: 200, Duration: 20, TotalPages: 10, UpdatedAtMs: intPtr(200)},
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.PullStatPages(ctx, "owner", 0)
	if err != nil {
		t.Fatal(err)
	}
	// 1 migrated row + 2 new sessions.
	if len(rows) != 3 {
		t.Fatalf("want 3 rows after migration got %d", len(rows))
	}
}
