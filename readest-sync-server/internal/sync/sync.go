package sync

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"readestsync/internal/middleware"
	"readestsync/internal/store"
)

type SyncHandler struct {
	ms store.MetadataStore
}

func NewSyncHandler(ms store.MetadataStore) *SyncHandler {
	return &SyncHandler{ms: ms}
}

func (h *SyncHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.pull(w, r)
	case http.MethodPost:
		h.push(w, r)
	default:
		http.Error(w, "", http.StatusMethodNotAllowed)
	}
}

func (h *SyncHandler) pull(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	q := r.URL.Query()
	sinceMs, _ := strconv.ParseInt(q.Get("since"), 10, 64)
	typ := q.Get("type")
	ctx := r.Context()

	switch typ {
	case "books", "":
		rows, err := h.ms.PullBooks(ctx, uid, isoFromMs(sinceMs), 1000)
		if err != nil {
			writeError(w, err)
			return
		}
		out := &SyncResult{Books: make([]json.RawMessage, 0, len(rows))}
		for _, b := range rows {
			out.Books = append(out.Books, json.RawMessage(b.Data))
		}
		writeJSON(w, out)
	case "notes":
		rows, err := h.ms.PullNotes(ctx, uid, sinceMs)
		if err != nil {
			writeError(w, err)
			return
		}
		out := &SyncResult{Notes: make([]json.RawMessage, 0, len(rows))}
		for _, n := range rows {
			out.Notes = append(out.Notes, json.RawMessage(n))
		}
		writeJSON(w, out)
	case "configs":
		rows, err := h.ms.PullConfigs(ctx, uid, sinceMs)
		if err != nil {
			writeError(w, err)
			return
		}
		out := &SyncResult{Configs: make([]json.RawMessage, 0, len(rows))}
		for _, c := range rows {
			out.Configs = append(out.Configs, json.RawMessage(c))
		}
		writeJSON(w, out)
	case "stats":
		sb, err := h.ms.PullStatBooks(ctx, uid, sinceMs)
		if err != nil {
			writeError(w, err)
			return
		}
		sp, err := h.ms.PullStatPages(ctx, uid, sinceMs)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, &SyncResult{StatBooks: sb, StatPages: sp})
	default:
		http.Error(w, `{"error":"unknown type"}`, http.StatusBadRequest)
	}
}

func (h *SyncHandler) push(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	var payload struct {
		Books     []json.RawMessage    `json:"books"`
		Notes     []json.RawMessage    `json:"notes"`
		Configs   []json.RawMessage    `json:"configs"`
		StatBooks []store.StatBookRow  `json:"statBooks"`
		StatPages []store.StatPageRow  `json:"statPages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	now := time.Now().UTC().Format(time.RFC3339)

	for _, raw := range payload.Books {
		var b store.BookRow
		if err := json.Unmarshal(raw, &b); err != nil {
			continue
		}
		b.UserID = uid
		if b.SyncedAt == "" {
			b.SyncedAt = now
		}
		b.Data = raw
		if err := h.ms.UpsertBook(ctx, b); err != nil {
			writeError(w, err)
			return
		}
	}
	for _, raw := range payload.Notes {
		var n struct {
			ID        string `json:"id"`
			UpdatedAt *int64 `json:"updated_at"`
		}
		_ = json.Unmarshal(raw, &n)
		row := store.NoteRow{UserID: uid, NoteID: n.ID, UpdatedAt: n.UpdatedAt, Data: raw}
		if err := h.ms.UpsertNote(ctx, uid, mustJSON(row)); err != nil {
			writeError(w, err)
			return
		}
	}
	for _, raw := range payload.Configs {
		var c struct {
			ID        string `json:"id"`
			UpdatedAt *int64 `json:"updated_at"`
		}
		_ = json.Unmarshal(raw, &c)
		row := store.NoteRow{UserID: uid, NoteID: c.ID, UpdatedAt: c.UpdatedAt, Data: raw}
		if err := h.ms.UpsertConfig(ctx, uid, mustJSON(row)); err != nil {
			writeError(w, err)
			return
		}
	}
	if len(payload.StatBooks) > 0 {
		for i := range payload.StatBooks {
			payload.StatBooks[i].UserID = uid
		}
		if err := h.ms.UpsertStatBooks(ctx, payload.StatBooks); err != nil {
			writeError(w, err)
			return
		}
	}
	if len(payload.StatPages) > 0 {
		for i := range payload.StatPages {
			payload.StatPages[i].UserID = uid
		}
		if err := h.ms.UpsertStatPages(ctx, payload.StatPages); err != nil {
			writeError(w, err)
			return
		}
	}
	writeJSON(w, map[string]string{})
}
