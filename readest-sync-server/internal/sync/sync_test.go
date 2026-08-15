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
	// Client payload shape: camelCase Book with metadata as an object.
	body := []byte(`{"books":[{"hash":"h1","title":"Test","metadata":{"author":"A"},"updatedAt":1000}]}`)
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
	// Pulled record must be DB-shaped (snake_case, metadata serialized as a
	// JSON string) so the client's transformBookFromDB can parse it.
	var got struct {
		BookHash string `json:"book_hash"`
		Metadata string `json:"metadata"`
	}
	if err := json.Unmarshal(resp.Books[0], &got); err != nil {
		t.Fatal(err)
	}
	if got.BookHash != "h1" {
		t.Fatalf("book_hash = %q", got.BookHash)
	}
	if got.Metadata != `{"author":"A"}` {
		t.Fatalf("metadata = %q, want a JSON string", got.Metadata)
	}
}

func TestPushConfigsAndNotes(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	h := NewSyncHandler(ms)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")
	body := []byte(`{
		"configs":[{"bookHash":"h1","metaHash":"m1","progress":[1,200],"rsvpPosition":{"cfi":"epubcfi(/6/4)","wordText":"hi"},"updatedAt":1000}],
		"notes":[{"id":"n1","bookHash":"h1","metaHash":"m1","type":"highlight","cfi":"epubcfi(/6/4)","note":"hello","createdAt":900,"updatedAt":1000}]
	}`)
	req := newAuthedReq("POST", "/api/sync", body, tok)
	rec := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("push got %d", rec.Code)
	}
	req2 := newAuthedReq("GET", "/api/sync?since=0&type=configs", nil, tok)
	rec2 := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec2, req2)
	if rec2.Code != 200 {
		t.Fatal("config pull failed")
	}
	var cresp struct {
		Configs []json.RawMessage `json:"configs"`
	}
	json.Unmarshal(rec2.Body.Bytes(), &cresp)
	if len(cresp.Configs) != 1 {
		t.Fatalf("want 1 config got %d", len(cresp.Configs))
	}
	var cfg struct {
		BookHash string `json:"book_hash"`
		Progress string `json:"progress"`
	}
	if err := json.Unmarshal(cresp.Configs[0], &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.BookHash != "h1" {
		t.Fatalf("config book_hash = %q", cfg.BookHash)
	}
	if cfg.Progress != `[1,200]` {
		t.Fatalf("config progress = %q, want a JSON string", cfg.Progress)
	}
	req3 := newAuthedReq("GET", "/api/sync?since=0&type=notes", nil, tok)
	rec3 := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec3, req3)
	if rec3.Code != 200 {
		t.Fatal("notes pull failed")
	}
	var nresp struct {
		Notes []json.RawMessage `json:"notes"`
	}
	json.Unmarshal(rec3.Body.Bytes(), &nresp)
	if len(nresp.Notes) != 1 {
		t.Fatalf("want 1 note got %d", len(nresp.Notes))
	}
	var note struct {
		BookHash string `json:"book_hash"`
		ID       string `json:"id"`
	}
	if err := json.Unmarshal(nresp.Notes[0], &note); err != nil {
		t.Fatal(err)
	}
	if note.BookHash != "h1" || note.ID != "n1" {
		t.Fatalf("note = %+v", note)
	}
}

func TestPushAndPullStats(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	h := NewSyncHandler(ms)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")
	body := []byte(`{"statBooks":[{"bookHash":"h1","title":"T","authors":"A","updatedAtMs":0}],"statPages":[{"bookHash":"h1","page":12,"startTime":1700000000000,"duration":60,"totalPages":200,"updatedAtMs":0}]}`)
	req := newAuthedReq("POST", "/api/sync", body, tok)
	rec := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("push got %d", rec.Code)
	}

	req2 := newAuthedReq("GET", "/api/sync?since=0&type=stats", nil, tok)
	rec2 := httptest.NewRecorder()
	wrap(svc, h).ServeHTTP(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("pull failed: %d", rec2.Code)
	}
	var sbresp struct {
		StatBooks []json.RawMessage `json:"statBooks"`
	}
	json.Unmarshal(rec2.Body.Bytes(), &sbresp)
	if len(sbresp.StatBooks) != 1 {
		t.Fatalf("want 1 statBook got %d", len(sbresp.StatBooks))
	}
	var got struct {
		BookHash    string `json:"book_hash"`
		UpdatedAtMs int64  `json:"updated_at_ms"`
	}
	if err := json.Unmarshal(sbresp.StatBooks[0], &got); err != nil {
		t.Fatal(err)
	}
	if got.BookHash != "h1" {
		t.Fatalf("book_hash = %q", got.BookHash)
	}
	if got.UpdatedAtMs == 0 {
		t.Fatal("updated_at_ms was not set by server")
	}

	var spresp struct {
		StatPages []json.RawMessage `json:"statPages"`
	}
	json.Unmarshal(rec2.Body.Bytes(), &spresp)
	if len(spresp.StatPages) != 1 {
		t.Fatalf("want 1 statPage got %d", len(spresp.StatPages))
	}
	var pg struct {
		BookHash   string `json:"book_hash"`
		Page       int    `json:"page"`
		TotalPages int64  `json:"total_pages"`
	}
	if err := json.Unmarshal(spresp.StatPages[0], &pg); err != nil {
		t.Fatal(err)
	}
	if pg.BookHash != "h1" || pg.Page != 12 || pg.TotalPages != 200 {
		t.Fatalf("statPage = %+v", pg)
	}
}

func TestReplicaKeysRoundTrip(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")
	rh := NewReplicaHandler(ms)

	// POST a new replica key (the server generates the salt/saltId).
	body := []byte(`{"alg":"argon2id"}`)
	req := newAuthedReq("POST", "/api/sync/replica-keys", body, tok)
	rec := httptest.NewRecorder()
	middleware.RequireAuth(svc, http.HandlerFunc(rh.KeysPost)).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("post key got %d: %s", rec.Code, rec.Body.String())
	}
	var posted struct {
		Row struct {
			SaltID string `json:"saltId"`
			Alg    string `json:"alg"`
			Salt   string `json:"salt"`
		} `json:"row"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &posted); err != nil {
		t.Fatalf("unmarshal posted: %v", err)
	}
	if posted.Row.Alg != "argon2id" || posted.Row.SaltID == "" || posted.Row.Salt == "" {
		t.Fatalf("posted key = %+v", posted.Row)
	}

	// GET keys; the response must use camelCase field names expected by the client.
	req2 := newAuthedReq("GET", "/api/sync/replica-keys", nil, tok)
	rec2 := httptest.NewRecorder()
	middleware.RequireAuth(svc, http.HandlerFunc(rh.KeysGet)).ServeHTTP(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("list keys got %d", rec2.Code)
	}
	var got struct {
		Rows []struct {
			SaltID    string `json:"saltId"`
			Alg       string `json:"alg"`
			Salt      string `json:"salt"`
			CreatedAt string `json:"createdAt"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Rows) != 1 {
		t.Fatalf("want 1 key got %d", len(got.Rows))
	}
	if got.Rows[0].SaltID != posted.Row.SaltID {
		t.Fatalf("key mismatch: got=%+v posted=%+v", got.Rows[0], posted.Row)
	}
}

func TestPushRejectsForeignUser(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	h := NewSyncHandler(ms)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")
	// book claims a different user_id; server must force to owner
	body := []byte(`{"books":[{"hash":"h1","title":"Test","user_id":"attacker","updatedAt":1000}]}`)
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
