package sync

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"readestsync/internal/auth"
	"readestsync/internal/store"
)

func TestReplicaPushPull(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	h := NewReplicaHandler(ms)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")

	// POST rows
	body, _ := json.Marshal(map[string]interface{}{
		"rows": []map[string]interface{}{
			{
				"kind":          "book",
				"replica_id":    "r1",
				"fields_jsonb":  map[string]interface{}{"x": map[string]interface{}{"v": 1, "t": 1, "s": "a"}},
				"updated_at_ts": "0000000000001-00000000-dev-a",
			},
		},
	})
	rec := httptest.NewRecorder()
	wrap(svc, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.Post(w, r) })).ServeHTTP(rec, newAuthedReq("POST", "/api/sync/replicas", body, tok))
	if rec.Code != 200 {
		t.Fatalf("push got %d: %s", rec.Code, rec.Body.String())
	}

	// GET since null
	rec2 := httptest.NewRecorder()
	wrap(svc, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.Get(w, r) })).ServeHTTP(rec2, newAuthedReq("GET", "/api/sync/replicas?kind=book", nil, tok))
	if rec2.Code != 200 {
		t.Fatalf("get got %d body=%s", rec2.Code, rec2.Body.String())
	}
	var g struct {
		Rows []ReplicaRow `json:"rows"`
	}
	json.Unmarshal(rec2.Body.Bytes(), &g)
	if len(g.Rows) != 1 {
		t.Fatalf("want 1 row got %d", len(g.Rows))
	}

	// batch cursors
	body2, _ := json.Marshal(map[string]interface{}{
		"cursors": []map[string]interface{}{{"kind": "book"}},
	})
	rec3 := httptest.NewRecorder()
	wrap(svc, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.Post(w, r) })).ServeHTTP(rec3, newAuthedReq("POST", "/api/sync/replicas", body2, tok))
	if rec3.Code != 200 {
		t.Fatalf("batch got %d", rec3.Code)
	}
	var b struct {
		Results []struct {
			Kind string       `json:"kind"`
			Rows []ReplicaRow `json:"rows"`
		} `json:"results"`
	}
	json.Unmarshal(rec3.Body.Bytes(), &b)
	if len(b.Results) != 1 || len(b.Results[0].Rows) != 1 {
		t.Fatalf("batch result wrong: %+v", b)
	}
}

func TestReplicaKeys(t *testing.T) {
	ms, _ := store.NewSqliteStore(":memory:")
	h := NewReplicaHandler(ms)
	svc := auth.NewService("c", "s")
	tok, _ := svc.IssueToken("owner")

	// POST key
	rec := httptest.NewRecorder()
	wrap(svc, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.KeysPost(w, r) })).ServeHTTP(rec, newAuthedReq("POST", "/api/sync/replica-keys", []byte(`{"alg":"sha256"}`), tok))
	if rec.Code != 200 {
		t.Fatalf("key post got %d", rec.Code)
	}
	var kp struct {
		Row ReplicaKeyRow `json:"row"`
	}
	json.Unmarshal(rec.Body.Bytes(), &kp)
	if kp.Row.SaltID == "" || kp.Row.Alg != "sha256" {
		t.Fatalf("key row wrong: %+v", kp.Row)
	}

	// GET keys
	rec2 := httptest.NewRecorder()
	wrap(svc, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.KeysGet(w, r) })).ServeHTTP(rec2, newAuthedReq("GET", "/api/sync/replica-keys", nil, tok))
	if rec2.Code != 200 {
		t.Fatalf("key get got %d", rec2.Code)
	}

	// DELETE keys
	rec3 := httptest.NewRecorder()
	wrap(svc, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.KeysDelete(w, r) })).ServeHTTP(rec3, newAuthedReq("DELETE", "/api/sync/replica-keys", nil, tok))
	if rec3.Code != http.StatusNoContent {
		t.Fatalf("key delete got %d", rec3.Code)
	}
}
