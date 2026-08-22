package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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

// TestBlobSpecialFilenamesRoundTrip exercises the full upload→download flow
// with filenames containing non-ASCII (Chinese) characters, spaces and other
// URL-significant characters. The client builds the blob URL by naive string
// concatenation ("/api/storage/blob/" + key) and relies on the HTTP stack to
// percent-encode it, so the server must decode consistently on both PUT and
// GET or files with such names 404 on download.
func TestBlobSpecialFilenamesRoundTrip(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	fs, _ := store.NewLocalDiskStore(t.TempDir())
	h := NewStorageHandler(ms, fs, 1<<30)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")

	r := chi.NewRouter()
	r.Put("/api/storage/blob/*", h.BlobPut)
	r.Get("/api/storage/blob/*", h.BlobGet)
	mw := middleware.RequireAuth(svc, r)

	// Filenames as makeSafeFilename would produce them for Chinese titles.
	cases := []struct {
		name     string // raw filename
		encoded  string // percent-encoded form as the HTTP client sends it
	}{
		{"三体.epub", "%E4%B8%89%E4%BD%93.epub"},
		{"我的书 第一卷.epub", "%E6%88%91%E7%9A%84%E4%B9%A6%20%E7%AC%AC%E4%B8%80%E5%8D%B7.epub"},
		{"Book (2nd Ed).epub", "Book%20%282nd%20Ed%29.epub"},
		{"A&B+C!@~'`.epub", "A%26B%2BC%21%40~%27%60.epub"},
	}
	for _, c := range cases {
		rawKey := "owner/Readest/Books/h1/" + c.name
		encURL := "/api/storage/blob/owner/Readest/Books/h1/" + c.encoded
		body := []byte("content-of-" + c.name)

		// Upload via the API: POST /api/storage/upload gives back the uploadUrl.
		upBody, _ := json.Marshal(map[string]interface{}{
			"fileName": "Readest/Books/h1/" + c.name,
			"bookHash": "h1",
			"fileSize": len(body),
		})
		rec := httptest.NewRecorder()
		wrapH(svc, h.Upload).ServeHTTP(rec, authed("POST", "/api/storage/upload", upBody, tok))
		if rec.Code != 200 {
			t.Fatalf("[%s] upload API got %d", c.name, rec.Code)
		}
		var upResp struct {
			UploadURL string `json:"uploadUrl"`
		}
		json.Unmarshal(rec.Body.Bytes(), &upResp)
		if upResp.UploadURL != "/api/storage/blob/"+rawKey {
			t.Fatalf("[%s] uploadUrl = %q, want %q", c.name, upResp.UploadURL, "/api/storage/blob/"+rawKey)
		}

		// PUT the blob at the percent-encoded URL (what reqwest/fetch send).
		rec2 := httptest.NewRecorder()
		mw.ServeHTTP(rec2, authed("PUT", encURL, body, tok))
		if rec2.Code != 200 {
			t.Fatalf("[%s] blob PUT got %d: %s", c.name, rec2.Code, rec2.Body.String())
		}

		// Download URL lookup: GET /api/storage/download?fileKey=<encoded key>.
		rec3 := httptest.NewRecorder()
		wrapH(svc, h.Download).ServeHTTP(rec3, authed(
			"GET", "/api/storage/download?fileKey="+url.QueryEscape(rawKey), nil, tok))
		if rec3.Code != 200 {
			t.Fatalf("[%s] download API got %d", c.name, rec3.Code)
		}
		var dlResp struct {
			DownloadURL string `json:"downloadUrl"`
		}
		json.Unmarshal(rec3.Body.Bytes(), &dlResp)
		if dlResp.DownloadURL != "/api/storage/blob/"+rawKey {
			t.Fatalf("[%s] downloadUrl = %q, want %q", c.name, dlResp.DownloadURL, "/api/storage/blob/"+rawKey)
		}

		// GET the blob at the same encoded URL.
		rec4 := httptest.NewRecorder()
		mw.ServeHTTP(rec4, authed("GET", encURL, nil, tok))
		if rec4.Code != 200 {
			t.Fatalf("[%s] blob GET got %d: %s", c.name, rec4.Code, rec4.Body.String())
		}
		if rec4.Body.String() != string(body) {
			t.Fatalf("[%s] blob content mismatch: %q", c.name, rec4.Body.String())
		}

		// Range GET (the multi-part download path) must also work.
		rec5 := httptest.NewRecorder()
		req := authed("GET", encURL, nil, tok)
		req.Header.Set("Range", "bytes=0-3")
		mw.ServeHTTP(rec5, req)
		if rec5.Code != http.StatusPartialContent {
			t.Fatalf("[%s] range GET got %d", c.name, rec5.Code)
		}
		if rec5.Body.String() != string(body[:4]) {
			t.Fatalf("[%s] range content mismatch: %q", c.name, rec5.Body.String())
		}
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
