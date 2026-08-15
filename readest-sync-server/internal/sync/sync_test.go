package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"readestsync/internal/auth"
	"readestsync/internal/middleware"
	"readestsync/internal/store"
)

func newAuthedReq(method, target string, body []byte, tok string) *http.Request {
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	return req
}

// wrap wraps a handler with the auth middleware so UserID is populated,
// mirroring how main.go mounts protected routes.
func wrap(svc *auth.Service, h http.Handler) http.Handler {
	return middleware.RequireAuth(svc, h)
}

func TestPullSince(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	now := int64(1000)
	ms.UpsertBook(context.Background(), store.BookRow{ID: "1", UserID: "owner", BookHash: "h1", UpdatedAt: &now, SyncedAt: "2024-01-01T00:00:01Z", Data: []byte(`{"id":"1","book_hash":"h1"}`)})
	h := NewSyncHandler(ms)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")
	req := newAuthedReq("GET", "/api/sync?since=0&type=books", nil, tok)
	rec := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
	var resp struct {
		Books []json.RawMessage `json:"books"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Books) != 1 {
		t.Fatalf("want 1 book got %d", len(resp.Books))
	}
}

func TestPushBooks(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	h := NewSyncHandler(ms)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")
	body := []byte(`{"books":[{"id":"1","book_hash":"h1","user_id":"owner","updated_at":1000}]}`)
	req := newAuthedReq("POST", "/api/sync", body, tok)
	rec := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
	// pull again
	req2 := newAuthedReq("GET", "/api/sync?since=0&type=books", nil, tok)
	rec2 := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec2, req2)
	if rec2.Code != 200 {
		t.Fatal("pull failed")
	}
	var resp struct {
		Books []json.RawMessage `json:"books"`
	}
	json.Unmarshal(rec2.Body.Bytes(), &resp)
	if len(resp.Books) != 1 {
		t.Fatalf("want 1 got %d", len(resp.Books))
	}
}

func TestPushRejectsForeignUser(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	h := NewSyncHandler(ms)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")
	// book claims a different user_id; server must force to owner
	body := []byte(`{"books":[{"id":"1","book_hash":"h1","user_id":"attacker","updated_at":1000}]}`)
	req := newAuthedReq("POST", "/api/sync", body, tok)
	rec := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
	rows, _ := ms.PullBooks(context.Background(), "owner", "", 100)
	if len(rows) != 1 || rows[0].UserID != "owner" {
		t.Fatalf("user_id not forced to owner: %+v", rows)
	}
}
