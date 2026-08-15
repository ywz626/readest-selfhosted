package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"readestsync/internal/ratelimit"
)

func TestAuthHandler(t *testing.T) {
	svc := NewService("code", "secret")
	limiter := ratelimit.NewLoginLimiter(3, 15*time.Minute, time.Hour)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		LoginHandler(svc, limiter, w, r)
	})

	body, _ := json.Marshal(map[string]string{"code": "code"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/auth", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("want 200 got %d", rec.Code)
	}
	var resp struct {
		AccessToken string `json:"access_token"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.AccessToken == "" {
		t.Fatal("empty token")
	}

	body2, _ := json.Marshal(map[string]string{"code": "x"})
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest("POST", "/api/auth", bytes.NewReader(body2)))
	if rec2.Code != 401 {
		t.Fatalf("want 401 got %d", rec2.Code)
	}
}

func TestAuthHandlerDeviceLock(t *testing.T) {
	svc := NewService("code", "secret")
	limiter := ratelimit.NewLoginLimiter(3, 15*time.Minute, time.Hour)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		LoginHandler(svc, limiter, w, r)
	})

	// 3 consecutive wrong attempts from the same device -> lock (429).
	for i := 0; i < 3; i++ {
		body, _ := json.Marshal(map[string]string{"code": "wrong"})
		req := httptest.NewRequest("POST", "/api/auth", bytes.NewReader(body))
		req.Header.Set("X-Device-Id", "test-device")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if i < 2 && rec.Code != 401 {
			t.Fatalf("attempt %d want 401 got %d", i+1, rec.Code)
		}
	}
	body, _ := json.Marshal(map[string]string{"code": "code"})
	req := httptest.NewRequest("POST", "/api/auth", bytes.NewReader(body))
	req.Header.Set("X-Device-Id", "test-device")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429 after lock, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("locked response must include Retry-After")
	}
}
