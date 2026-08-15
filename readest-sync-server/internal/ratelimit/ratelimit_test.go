package ratelimit

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func reqWithDevice(id string) *http.Request {
	r := httptest.NewRequest("POST", "/api/auth", nil)
	if id != "" {
		r.Header.Set("X-Device-Id", id)
	}
	return r
}

func TestLoginLimiterLocksAfterMaxFailures(t *testing.T) {
	l := NewLoginLimiter(3, time.Minute, 0)
	dev := "device-A"

	// First two failures: still allowed.
	for i := 0; i < 2; i++ {
		if ok, _ := l.Allow(reqWithDevice(dev)); !ok {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
		l.RecordFailure(reqWithDevice(dev))
	}

	// Third failure reaches the threshold and locks.
	l.RecordFailure(reqWithDevice(dev))
	ok, wait := l.Allow(reqWithDevice(dev))
	if ok {
		t.Fatal("device should be locked after 3 failures")
	}
	if wait <= 0 {
		t.Fatal("lock duration should be positive")
	}
}

func TestLoginLimiterResetOnSuccess(t *testing.T) {
	l := NewLoginLimiter(3, time.Minute, 0)
	dev := "device-B"

	l.RecordFailure(reqWithDevice(dev))
	l.RecordFailure(reqWithDevice(dev))
	l.RecordSuccess(reqWithDevice(dev))

	if ok, _ := l.Allow(reqWithDevice(dev)); !ok {
		t.Fatal("success should reset the failure counter")
	}
	// After reset, three more failures are needed to lock again.
	l.RecordFailure(reqWithDevice(dev))
	l.RecordFailure(reqWithDevice(dev))
	if ok, _ := l.Allow(reqWithDevice(dev)); !ok {
		t.Fatal("counter was reset; should not be locked yet")
	}
	l.RecordFailure(reqWithDevice(dev))
	if ok, _ := l.Allow(reqWithDevice(dev)); ok {
		t.Fatal("device should now be locked")
	}
}

func TestLoginLimiterIsolatesDevices(t *testing.T) {
	l := NewLoginLimiter(1, time.Minute, 0)
	r1 := reqWithDevice("dev-1")
	r1.RemoteAddr = "203.0.113.1:1000"
	r2 := reqWithDevice("dev-2")
	r2.RemoteAddr = "203.0.113.2:1000"
	l.RecordFailure(r1)
	if ok, _ := l.Allow(r2); !ok {
		t.Fatal("a different device on a different IP must not be affected by another's lock")
	}
	if ok, _ := l.Allow(r1); ok {
		t.Fatal("dev-1 should be locked after 1 failure")
	}
}

func TestLoginLimiterIPFallbackBlocksRotatingDeviceIDs(t *testing.T) {
	l := NewLoginLimiter(3, time.Minute, 0)
	// Same IP, rotating device ids: the IP identity accumulates failures and
	// locks even though no single device id reaches the threshold.
	for i := 0; i < 3; i++ {
		r := reqWithDevice(fmt.Sprintf("dev-rot-%d", i))
		r.RemoteAddr = "203.0.113.9:1000"
		l.RecordFailure(r)
	}
	r := reqWithDevice("dev-fresh")
	r.RemoteAddr = "203.0.113.9:1000"
	if ok, _ := l.Allow(r); ok {
		t.Fatal("IP-based counter should lock after 3 failures across devices")
	}
}

func TestLoginLimiterFallsBackToIP(t *testing.T) {
	l := NewLoginLimiter(1, time.Minute, 0)
	r := httptest.NewRequest("POST", "/api/auth", nil)
	r.RemoteAddr = "203.0.113.9:54321"
	l.RecordFailure(r)
	if ok, _ := l.Allow(r); ok {
		t.Fatal("IP-based identity should be locked after 1 failure")
	}
}
