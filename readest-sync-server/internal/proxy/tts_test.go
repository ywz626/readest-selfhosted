package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEdgeTTSHandlerShape(t *testing.T) {
	// GET voices: network-dependent; just ensure it returns without panic.
	rec := httptest.NewRecorder()
	EdgeTTS(rec, httptest.NewRequest("GET", "/api/tts/edge", nil))
	// 200 (voices) or 500 (network blocked) are both acceptable.
	if rec.Code != http.StatusOK && rec.Code != http.StatusInternalServerError {
		t.Fatalf("unexpected code %d", rec.Code)
	}
}

func TestEdgeTTSPostShape(t *testing.T) {
	body, _ := json.Marshal(map[string]interface{}{"text": "hello", "voice": "en-US-AriaNeural"})
	rec := httptest.NewRecorder()
	EdgeTTS(rec, httptest.NewRequest("POST", "/api/tts/edge", bytes.NewReader(body)))
	// 200 (audio) or 500 (network blocked) acceptable.
	if rec.Code != http.StatusOK && rec.Code != http.StatusInternalServerError {
		t.Fatalf("unexpected code %d", rec.Code)
	}
}
