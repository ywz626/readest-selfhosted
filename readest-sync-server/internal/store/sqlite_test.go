package store

import (
	"context"
	"testing"
)

func TestSqliteUpsertPullBook(t *testing.T) {
	s, err := NewSqliteStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
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
