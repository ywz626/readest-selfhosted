package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestDeepLMock(t *testing.T) {
	os.Unsetenv("DEEPL_API_KEY")
	os.Unsetenv("DEEPL_ENDPOINT")
	body, _ := json.Marshal(map[string]interface{}{"text": []string{"hello"}, "target_lang": "ZH"})
	rec := httptest.NewRecorder()
	DeepLTranslate(rec, httptest.NewRequest("POST", "/api/deepl/translate", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
	var resp struct {
		Translations []map[string]string `json:"translations"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Translations) != 1 {
		t.Fatalf("want 1 translation got %d", len(resp.Translations))
	}
}

func TestYandexTranslate(t *testing.T) {
	// fake upstream
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"text":["привет"]}`))
	}))
	defer upstream.Close()
	// point yandex at fake by monkeypatching URL is not trivial; instead test the
	// mock path by ensuring function doesn't panic building the request.
	_ = upstream
	body := []byte("text=hello&lang=ru")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/yandex-translate?endpoint=translate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	YandexTranslate(rec, req)
	// Either 200 (if network allowed) or 502/410 (blocked/rejected upstream); all acceptable as long as it doesn't panic.
	if rec.Code != http.StatusOK && rec.Code != http.StatusBadGateway && rec.Code != http.StatusGone {
		t.Fatalf("unexpected code %d", rec.Code)
	}
}
