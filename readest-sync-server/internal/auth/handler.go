package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"readestsync/internal/ratelimit"
)

func formatDuration(d time.Duration) string {
	secs := int(d.Seconds())
	if secs < 1 {
		secs = 1
	}
	return fmt.Sprintf("%d", secs)
}

func LoginHandler(svc *Service, limiter *ratelimit.LoginLimiter, w http.ResponseWriter, r *http.Request) {
	// Brute-force protection: reject (and report remaining lock) when the
	// client/device is locked out after too many consecutive failures.
	if limiter != nil {
		if ok, wait := limiter.Allow(r); !ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", formatDuration(wait))
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"too many failures, device locked","code":"LOCKED"}`))
			return
		}
	}

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"bad request"}`))
		return
	}
	if !svc.CheckCode(req.Code) {
		if limiter != nil {
			limiter.RecordFailure(r)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"invalid code"}`))
		return
	}
	if limiter != nil {
		limiter.RecordSuccess(r)
	}
	tok, err := svc.IssueToken("owner")
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"internal"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"access_token": tok, "token_type": "bearer"})
}

