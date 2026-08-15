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
		Books     []json.RawMessage `json:"books"`
		Notes     []json.RawMessage `json:"notes"`
		Configs   []json.RawMessage `json:"configs"`
		StatBooks []statBookWire    `json:"statBooks"`
		StatPages []statPageWire    `json:"statPages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	now := time.Now().UTC().Format(time.RFC3339)

	for _, raw := range payload.Books {
		var p pushedBook
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if p.Hash == "" {
			continue
		}
		b := store.BookRow{
			ID:        p.Hash,
			UserID:    uid,
			BookHash:  p.Hash,
			MetaHash:  p.MetaHash,
			UpdatedAt: p.UpdatedAt,
			DeletedAt: p.DeletedAt,
			SyncedAt:  now,
			// Convert to DB shape (snake_case, metadata as a JSON string,
			// ISO-8601 timestamps) so the client's transformBookFromDB can
			// parse the record it pulls back.
			Data: mustJSON(bookToDB(&p, uid, now)),
		}
		if err := h.ms.UpsertBook(ctx, b); err != nil {
			writeError(w, err)
			return
		}
	}
	for _, raw := range payload.Notes {
		var p pushedNote
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if p.ID == "" {
			continue
		}
		if err := h.ms.UpsertNote(ctx, uid, mustJSON(noteToDB(&p, uid))); err != nil {
			writeError(w, err)
			return
		}
	}
	for _, raw := range payload.Configs {
		var p pushedConfig
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if p.BookHash == "" {
			continue
		}
		if err := h.ms.UpsertConfig(ctx, uid, mustJSON(configToDB(&p, uid))); err != nil {
			writeError(w, err)
			return
		}
	}
	if len(payload.StatBooks) > 0 {
		bookRows := make([]store.StatBookRow, 0, len(payload.StatBooks))
		for _, w := range payload.StatBooks {
			if w.BookHash == "" {
				continue
			}
			updatedAtMs := w.UpdatedAtMs
			if updatedAtMs == nil || *updatedAtMs == 0 {
				t := time.Now().UnixMilli()
				updatedAtMs = &t
			}
			bookRows = append(bookRows, store.StatBookRow{
				UserID:      uid,
				BookHash:    w.BookHash,
				Title:       w.Title,
				Authors:     w.Authors,
				UpdatedAtMs: updatedAtMs,
				DeletedAt:   w.DeletedAt,
			})
		}
		if len(bookRows) > 0 {
			if err := h.ms.UpsertStatBooks(ctx, bookRows); err != nil {
				writeError(w, err)
				return
			}
		}
	}
	if len(payload.StatPages) > 0 {
		pageRows := make([]store.StatPageRow, 0, len(payload.StatPages))
		for _, w := range payload.StatPages {
			if w.BookHash == "" {
				continue
			}
			updatedAtMs := w.UpdatedAtMs
			if updatedAtMs == nil || *updatedAtMs == 0 {
				t := time.Now().UnixMilli()
				updatedAtMs = &t
			}
			pageRows = append(pageRows, store.StatPageRow{
				UserID:      uid,
				BookHash:    w.BookHash,
				Page:        w.Page,
				StartTime:   w.StartTime,
				Duration:    w.Duration,
				TotalPages:  w.TotalPages,
				UpdatedAtMs: updatedAtMs,
				DeletedAt:   w.DeletedAt,
			})
		}
		if len(pageRows) > 0 {
			if err := h.ms.UpsertStatPages(ctx, pageRows); err != nil {
				writeError(w, err)
				return
			}
		}
	}
	writeJSON(w, map[string]string{})
}
