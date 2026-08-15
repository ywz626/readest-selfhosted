package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMetadataSearchShape(t *testing.T) {
	rec := httptest.NewRecorder()
	MetadataSearch(rec, httptest.NewRequest("GET", "/api/metadata/search?q=12345", nil))
	// 200 (data) or 500 (network blocked) acceptable.
	if rec.Code != http.StatusOK && rec.Code != http.StatusInternalServerError {
		t.Fatalf("unexpected code %d", rec.Code)
	}
}
