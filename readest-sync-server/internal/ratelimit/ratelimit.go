package ratelimit

import (
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

// FormatDuration renders a duration as an integer number of seconds, suitable
// for the HTTP `Retry-After` header.
func FormatDuration(d time.Duration) string {
	secs := int(d.Seconds())
	if secs < 1 {
		secs = 1
	}
	return fmt.Sprintf("%d", secs)
}

// LoginLimiter provides brute-force protection for the login endpoint.
//
// It tracks consecutive failed login attempts per client identity (IP by
// default, or a device id supplied via the `X-Device-Id` header). After
// MaxFailures consecutive failures the identity is locked out for LockDuration.
// A single successful login resets the failure counter.
type LoginLimiter struct {
	mu            sync.Mutex
	entries       map[string]*loginState
	maxFailures   int
	lockDuration  time.Duration
	window        time.Duration
	cleanupEvery  int
	cleanupCount  int
}

type loginState struct {
	failures  int
	lockedUntil time.Time
	lastSeen  time.Time
}

// NewLoginLimiter builds a limiter. maxFailures is the number of consecutive
// failures before a lock; lockDuration is how long the lock lasts; window is
// the idle TTL after which a counter is forgotten (0 disables expiry).
func NewLoginLimiter(maxFailures int, lockDuration, window time.Duration) *LoginLimiter {
	if maxFailures < 1 {
		maxFailures = 1
	}
	return &LoginLimiter{
		entries:      make(map[string]*loginState),
		maxFailures:  maxFailures,
		lockDuration: lockDuration,
		window:       window,
	}
}

// clientKeys derives the identities to track for a request. The client
// supplied device id (from the `X-Device-Id` header) is tracked so the lock
// is bound to the *device*, and the client IP is always tracked as a fallback
// so an attacker rotating device ids cannot bypass the brute-force lock.
func clientKeys(r *http.Request) []string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = h
	}
	keys := []string{"ip:" + host}
	if id := r.Header.Get("X-Device-Id"); id != "" {
		keys = append(keys, "dev:"+id)
	}
	return keys
}

// Allow reports whether a login attempt may proceed and, if not, how long the
// caller must wait. It does NOT record the outcome — call RecordSuccess or
// RecordFailure afterwards. The request is allowed only when every tracked
// identity (IP and, when present, device id) is free of an active lock.
func (l *LoginLimiter) Allow(r *http.Request) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.maybeCleanup()

	now := time.Now()
	wait := time.Duration(0)
	for _, key := range clientKeys(r) {
		s, ok := l.entries[key]
		if !ok {
			continue
		}
		if now.Before(s.lockedUntil) {
			if d := s.lockedUntil.Sub(now); d > wait {
				wait = d
			}
		}
	}
	return wait <= 0, wait
}

// RecordSuccess resets the failure counter and any lock for every identity of
// the request.
func (l *LoginLimiter) RecordSuccess(r *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, key := range clientKeys(r) {
		delete(l.entries, key)
	}
}

// RecordFailure increments the failure counter for every identity of the
// request and locks each identity once the consecutive-failure threshold is
// reached.
func (l *LoginLimiter) RecordFailure(r *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	for _, key := range clientKeys(r) {
		s, ok := l.entries[key]
		if !ok {
			s = &loginState{}
			l.entries[key] = s
		}
		s.failures++
		s.lastSeen = now
		if s.failures >= l.maxFailures {
			s.lockedUntil = now.Add(l.lockDuration)
		}
	}
}

// maybeCleanup evicts stale entries to bound memory usage.
func (l *LoginLimiter) maybeCleanup() {
	if l.window <= 0 {
		return
	}
	l.cleanupCount++
	if l.cleanupCount < l.cleanupEvery {
		return
	}
	l.cleanupCount = 0
	now := time.Now()
	for k, s := range l.entries {
		if now.Sub(s.lastSeen) > l.window && now.After(s.lockedUntil) {
			delete(l.entries, k)
		}
	}
}
