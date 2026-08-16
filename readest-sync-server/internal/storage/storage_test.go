package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"readestsync/internal/auth"
	"readestsync/internal/middleware"
	"readestsync/internal/store"
)

func authed(method, target string, body []byte, tok string) *http.Request {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	} else {
		rdr = http.NoBody
	}
	req := httptest.NewRequest(method, target, rdr)
	req.Header.Set("Authorization", "Bearer "+tok)
	return req
}

func wrapH(svc *auth.Service, fn func(http.ResponseWriter, *http.Request)) http.Handler {
	return middleware.RequireAuth(svc, http.HandlerFunc(fn))
}

func TestUploadReturnsURL(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	fs, _ := store.NewLocalDiskStore(t.TempDir())
	h := NewStorageHandler(ms, fs, 1<<30)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")

	body, _ := json.Marshal(map[string]interface{}{"fileName": "h1.epub", "bookHash": "h1", "fileSize": 10})
	rec := httptest.NewRecorder()
	wrapH(svc, h.Upload).ServeHTTP(rec, authed("POST", "/api/storage/upload", body, tok))
	if rec.Code != 200 {
		t.Fatalf("upload got %d", rec.Code)
	}
	var resp struct {
		UploadURL string `json:"uploadUrl"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.UploadURL == "" {
		t.Fatal("empty uploadUrl")
	}
}

func TestListStatsDelete(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	fs, _ := store.NewLocalDiskStore(t.TempDir())
	h := NewStorageHandler(ms, fs, 1<<30)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")

	ctx := context.Background()
	fs.Put(ctx, "owner/Readest/Books/h1/h1.epub", strings.NewReader("hello"), 5)

	// list
	rec := httptest.NewRecorder()
	wrapH(svc, h.List).ServeHTTP(rec, authed("GET", "/api/storage/list", nil, tok))
	if rec.Code != 200 {
		t.Fatalf("list got %d", rec.Code)
	}
	var lst struct {
		Files      []map[string]interface{} `json:"files"`
		Total      int                      `json:"total"`
		TotalPages int                      `json:"totalPages"`
	}
	json.Unmarshal(rec.Body.Bytes(), &lst)
	if lst.Total != 1 {
		t.Fatalf("want total 1 got %d", lst.Total)
	}

	// stats
	rec2 := httptest.NewRecorder()
	wrapH(svc, h.Stats).ServeHTTP(rec2, authed("GET", "/api/storage/stats", nil, tok))
	if rec2.Code != 200 {
		t.Fatalf("stats got %d", rec2.Code)
	}
	var st struct {
		Quota int64 `json:"quota"`
	}
	json.Unmarshal(rec2.Body.Bytes(), &st)
	if st.Quota <= 0 {
		t.Fatalf("quota not set: %d", st.Quota)
	}

	// delete
	rec3 := httptest.NewRecorder()
	wrapH(svc, h.Delete).ServeHTTP(rec3, authed("DELETE", "/api/storage/delete?fileKey=owner/Readest/Books/h1/h1.epub", nil, tok))
	if rec3.Code != 200 {
		t.Fatalf("delete got %d", rec3.Code)
	}
}

func TestBlobPutGet(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	fs, _ := store.NewLocalDiskStore(t.TempDir())
	h := NewStorageHandler(ms, fs, 1<<30)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")

	// Mount a chi router exactly like main.go so URL params are extracted.
	r := chi.NewRouter()
	r.Put("/api/storage/blob/*", h.BlobPut)
	r.Get("/api/storage/blob/*", h.BlobGet)
	mw := middleware.RequireAuth(svc, r)

	// PUT
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, authed("PUT", "/api/storage/blob/owner/Readest/Books/h1/h1.epub", []byte("hello world"), tok))
	if rec.Code != 200 {
		t.Fatalf("blob put got %d", rec.Code)
	}
	// GET
	rec2 := httptest.NewRecorder()
	mw.ServeHTTP(rec2, authed("GET", "/api/storage/blob/owner/Readest/Books/h1/h1.epub", nil, tok))
	if rec2.Code != 200 {
		t.Fatalf("blob get got %d", rec2.Code)
	}
	if rec2.Body.String() != "hello world" {
		t.Fatalf("blob content mismatch: %q", rec2.Body.String())
	}
	// isolation: other user denied
	rec3 := httptest.NewRecorder()
	mw.ServeHTTP(rec3, authed("GET", "/api/storage/blob/attacker/Readest/Books/x.epub", nil, tok))
	if rec3.Code != http.StatusForbidden {
		t.Fatalf("expected 403 got %d", rec3.Code)
	}
}

// TestBlobGetLegacyKey verifies that files uploaded with the pre-fix key layout
// (owner/books/<hash>/Readest/Books/<hash>/<file>) remain downloadable.
func TestBlobGetLegacyKey(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	fs, _ := store.NewLocalDiskStore(t.TempDir())
	h := NewStorageHandler(ms, fs, 1<<30)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")

	r := chi.NewRouter()
	r.Get("/api/storage/blob/*", h.BlobGet)
	mw := middleware.RequireAuth(svc, r)

	ctx := context.Background()
	if err := fs.Put(ctx, "owner/books/h1/Readest/Books/h1/h1.epub", strings.NewReader("legacy content"), 14); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, authed("GET", "/api/storage/blob/owner/Readest/Books/h1/h1.epub", nil, tok))
	if rec.Code != 200 {
		t.Fatalf("legacy blob get got %d", rec.Code)
	}
	if rec.Body.String() != "legacy content" {
		t.Fatalf("blob content mismatch: %q", rec.Body.String())
	}
}

func TestKeyParsers(t *testing.T) {
	cases := []struct {
		key      string
		hash     string
		wantKind string
		wantID   string
	}{
		{"owner/Readest/Books/h1/h1.epub", "h1", "", ""},
		{"owner/books/h1/h1.epub", "h1", "", ""},
		{"owner/Readest/Replicas/dict/d1/a.mdx", "", "dict", "d1"},
		{"owner/replicas/dict/d1/a.mdx", "", "dict", "d1"},
		{"owner/temp/x.tmp", "", "", ""},
	}
	for _, c := range cases {
		if bh := bookHashFromKey(c.key); (bh == nil && c.hash != "") || (bh != nil && *bh != c.hash) {
			t.Errorf("bookHashFromKey(%q) = %v, want %q", c.key, bh, c.hash)
		}
		kind, id := replicaInfoFromKey(c.key)
		if (kind == nil && c.wantKind != "") || (kind != nil && *kind != c.wantKind) ||
			(id == nil && c.wantID != "") || (id != nil && *id != c.wantID) {
			t.Errorf("replicaInfoFromKey(%q) = %v/%v, want %q/%q", c.key, kind, id, c.wantKind, c.wantID)
		}
	}
}

func TestLegacyStorageKey(t *testing.T) {
	cases := []struct {
		newKey   string
		legacy   string
		converts bool
	}{
		{"owner/Readest/Books/h1/h1.epub", "owner/books/h1/Readest/Books/h1/h1.epub", true},
		{"owner/Readest/Replicas/dict/d1/a.mdx", "owner/replicas/dict/d1/Readest/Replicas/dict/d1/a.mdx", true},
		{"owner/files/a.txt", "", false},
	}
	for _, c := range cases {
		got, ok := legacyStorageKey(c.newKey)
		if ok != c.converts || got != c.legacy {
			t.Errorf("legacyStorageKey(%q) = %q/%v, want %q/%v", c.newKey, got, ok, c.legacy, c.converts)
		}
	}
}
