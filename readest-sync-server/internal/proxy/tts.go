package proxy

import (
	"encoding/json"
	"net/http"

	edge "github.com/wujunwei928/edge-tts-go/edge_tts"
)

// EdgeTTS handles GET (list voices) and POST (synthesize audio).
// GET /api/tts/edge -> list available voices
// POST /api/tts/edge body {"text": "...", "voice": "...", "rate"?,"pitch"?,"volume"?,"ssml"?} -> audio/* bytes
func EdgeTTS(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		voices, err := edge.ListVoices("")
		if err != nil {
			writeError(w, err)
			return
		}
		out := make([]map[string]interface{}, 0, len(voices))
		for _, v := range voices {
			out = append(out, map[string]interface{}{
				"name":         v.ShortName,
				"display_name": v.FriendlyName,
				"locale":       v.Locale,
				"gender":       v.Gender,
			})
		}
		writeJSON(w, out)
	case http.MethodPost:
		var body struct {
			Text   string `json:"text"`
			Voice  string `json:"voice"`
			Rate   string `json:"rate"`
			Pitch  string `json:"pitch"`
			Volume string `json:"volume"`
			SSML   string `json:"ssml"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
			return
		}
		voice := body.Voice
		if voice == "" {
			voice = "en-US-AriaNeural"
		}
		opts := []edge.CommunicateOption{edge.SetVoice(voice)}
		if body.Rate != "" {
			opts = append(opts, edge.SetRate(body.Rate))
		}
		if body.Pitch != "" {
			opts = append(opts, edge.SetPitch(body.Pitch))
		}
		if body.Volume != "" {
			opts = append(opts, edge.SetVolume(body.Volume))
		}
		var (
			c   *edge.Communicate
			err error
		)
		if body.SSML != "" {
			c, err = edge.NewCommunicate(body.SSML, append(opts, edge.SetOutputFormat("webm"))...)
		} else {
			c, err = edge.NewCommunicate(body.Text, opts...)
		}
		if err != nil {
			writeError(w, err)
			return
		}
		audio, err := c.Stream()
		if err != nil {
			writeError(w, err)
			return
		}
		ct := c.GetContentType()
		if ct == "" {
			ct = "audio/mpeg"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(http.StatusOK)
		w.Write(audio)
	default:
		http.Error(w, "", http.StatusMethodNotAllowed)
	}
}
