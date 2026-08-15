package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"readestsync/internal/auth"
)

func TestRequireAuth(t *testing.T) {
	svc := auth.NewService("code", "secret")
	valid, _ := svc.IssueToken("owner")
	handler := RequireAuth(svc, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid := UserID(r)
		w.Write([]byte(uid))
	}))
	// no token -> 401
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if rec.Code != 401 {
		t.Fatalf("no token should 401, got %d", rec.Code)
	}
	// valid token -> 200 + owner
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer "+valid)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req)
	if rec2.Code != 200 || rec2.Body.String() != "owner" {
		t.Fatalf("got %d %q", rec2.Code, rec2.Body.String())
	}
}
