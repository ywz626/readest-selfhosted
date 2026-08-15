package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
)

// DeepL endpoint (configurable via env). When DEEPL_API_KEY is unset we return a
// harmless mock so the client never errors.
func DeepLTranslate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text       []string `json:"text"`
		SourceLang string   `json:"source_lang"`
		TargetLang string   `json:"target_lang"`
		UseCache   bool     `json:"use_cache"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	key := os.Getenv("DEEPL_API_KEY")
	endpoint := os.Getenv("DEEPL_ENDPOINT")
	if key == "" || endpoint == "" {
		// mock: echo back
		translations := make([]map[string]string, 0, len(body.Text))
		for _, t := range body.Text {
			translations = append(translations, map[string]string{"text": t})
		}
		writeJSON(w, map[string]interface{}{"translations": translations})
		return
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"text":        body.Text,
		"target_lang": body.TargetLang,
		"source_lang": body.SourceLang,
	})
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		writeError(w, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "DeepL-Auth-Key "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeError(w, err)
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	w.Write(data)
}

// YandexTranslate forwards to the free public Yandex translate endpoint.
func YandexTranslate(w http.ResponseWriter, r *http.Request) {
	endpoint := r.URL.Query().Get("endpoint")
	if endpoint != "session" && endpoint != "translate" {
		endpoint = "translate"
	}
	texts := r.URL.Query()["text"]
	lang := r.URL.Query().Get("lang")
	if lang == "" {
		lang = r.URL.Query().Get("target_lang")
	}
	u := "https://translate.yandex.net/api/v1/tr.json/translate?_" + endpoint
	form := url.Values{}
	for _, t := range texts {
		form.Add("text", t)
	}
	if lang != "" {
		form.Set("lang", lang)
	}
	resp, err := http.PostForm(u, form)
	if err != nil {
		writeError(w, err)
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	w.Write(data)
}
