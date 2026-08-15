package e2e_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"readestsync/internal/auth"
	"readestsync/internal/middleware"
	"readestsync/internal/store"
	"readestsync/internal/storage"
	"readestsync/internal/sync"

	"github.com/go-chi/chi/v5"
)

// buildApp wires the full router against in-memory sqlite + temp local disk,
// mirroring main.go but with test backends.
func buildApp(t *testing.T) (http.Handler, *auth.Service) {
	t.Helper()
	ms, err := store.NewSqliteStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	fs, err := store.NewLocalDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := auth.NewService("code", "secret")
	syncH := sync.NewSyncHandler(ms)
	replicaH := sync.NewReplicaHandler(ms)
	storageH := storage.NewStorageHandler(ms, fs, 1<<30)

	r := chi.NewRouter()
	r.Post("/api/auth", func(w http.ResponseWriter, r *http.Request) {
		auth.LoginHandler(svc, nil, w, r)
	})
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler { return middleware.RequireAuth(svc, next) })
		r.Get("/api/sync", syncH.ServeHTTP)
		r.Post("/api/sync", syncH.ServeHTTP)
		r.Post("/api/sync/replicas", replicaH.Post)
		r.Get("/api/sync/replicas", replicaH.Get)
		r.Post("/api/storage/upload", storageH.Upload)
		r.Put("/api/storage/blob/*", storageH.BlobPut)
		r.Get("/api/storage/blob/*", storageH.BlobGet)
		r.Get("/api/storage/stats", storageH.Stats)
	})
	return r, svc
}

func TestE2EFlow(t *testing.T) {
	app, svc := buildApp(t)

	// 1. login
	loginBody, _ := json.Marshal(map[string]string{"code": "code"})
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, httptest.NewRequest("POST", "/api/auth", bytes.NewReader(loginBody)))
	if rec.Code != 200 {
		t.Fatalf("login %d", rec.Code)
	}
	var login struct {
		AccessToken string `json:"access_token"`
	}
	json.Unmarshal(rec.Body.Bytes(), &login)
	tok := login.AccessToken
	if tok == "" {
		t.Fatal("empty token")
	}

	authReq := func(method, path string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		rr := httptest.NewRecorder()
		app.ServeHTTP(rr, req)
		return rr
	}

	// 2. push a book
	push := authReq("POST", "/api/sync", []byte(`{"books":[{"id":"1","book_hash":"h1","user_id":"owner","updated_at":1000}]}`))
	if push.Code != 200 {
		t.Fatalf("push %d", push.Code)
	}
	// 3. pull it back
	pull := authReq("GET", "/api/sync?since=0&type=books", nil)
	if pull.Code != 200 {
		t.Fatalf("pull %d", pull.Code)
	}
	var pr struct {
		Books []json.RawMessage `json:"books"`
	}
	json.Unmarshal(pull.Body.Bytes(), &pr)
	if len(pr.Books) != 1 {
		t.Fatalf("pull books %d", len(pr.Books))
	}

	// 4. upload a file via upload -> PUT -> GET
	up := authReq("POST", "/api/storage/upload", []byte(`{"fileName":"h1.epub","bookHash":"h1","fileSize":11}`))
	var upr struct {
		UploadURL string `json:"uploadUrl"`
	}
	json.Unmarshal(up.Body.Bytes(), &upr)
	if upr.UploadURL == "" {
		t.Fatal("no uploadUrl")
	}
	put := authReq("PUT", upr.UploadURL, []byte("hello world"))
	if put.Code != 200 {
		t.Fatalf("blob put %d", put.Code)
	}
	get := authReq("GET", upr.UploadURL, nil)
	if get.Code != 200 || get.Body.String() != "hello world" {
		t.Fatalf("blob get %d body=%q", get.Code, get.Body.String())
	}

	// 5. stats
	stats := authReq("GET", "/api/storage/stats", nil)
	if stats.Code != 200 {
		t.Fatalf("stats %d", stats.Code)
	}

	// 6. replica push/pull
	rep := authReq("POST", "/api/sync/replicas", []byte(`{"rows":[{"kind":"book","replica_id":"r1","updated_at_ts":"0000000000001-00000000-dev-a"}]}`))
	if rep.Code != 200 {
		t.Fatalf("replica push %d", rep.Code)
	}
	repg := authReq("GET", "/api/sync/replicas?kind=book", nil)
	if repg.Code != 200 {
		t.Fatalf("replica get %d", repg.Code)
	}

	_ = svc
}
