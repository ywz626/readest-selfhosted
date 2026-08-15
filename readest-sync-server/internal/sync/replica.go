package sync

import (
	"encoding/json"
	"net/http"

	"readestsync/internal/middleware"
	"readestsync/internal/store"
)

type ReplicaHandler struct {
	ms store.MetadataStore
}

func NewReplicaHandler(ms store.MetadataStore) *ReplicaHandler {
	return &ReplicaHandler{ms: ms}
}

// GET /api/sync/replicas?kind=&since=
func (h *ReplicaHandler) Get(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	kind := r.URL.Query().Get("kind")
	since := r.URL.Query().Get("since")
	var sincePtr *string
	if since != "" {
		s := since
		sincePtr = &s
	}
	rows, err := h.ms.PullReplicas(r.Context(), uid, kind, sincePtr)
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]ReplicaRow, 0, len(rows))
	for _, rr := range rows {
		out = append(out, toReplicaRow(rr))
	}
	writeJSON(w, map[string]interface{}{"rows": out})
}

// POST /api/sync/replicas
// body may contain {"rows":[...]} (upsert + echo) or {"cursors":[{kind,since}]} (batch pull)
func (h *ReplicaHandler) Post(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	var body struct {
		Rows    []ReplicaRow       `json:"rows"`
		Cursors []store.ReplicaCursor `json:"cursors"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	ctx := r.Context()

	if len(body.Rows) > 0 {
		for _, row := range body.Rows {
			rr := store.ReplicaRow{
				UserID:        uid,
				Kind:          row.Kind,
				ReplicaID:     row.ReplicaID,
				FieldsJSONB:   jsonRaw(row.FieldsJSONB),
				ManifestJSONB: jsonRaw(row.ManifestJSONB),
				DeletedAtTS:   row.DeletedAtTS,
				Reincarnation: row.Reincarnation,
				UpdatedAtTS:   row.UpdatedAtTS,
				SchemaVersion: row.SchemaVersion,
			}
			if err := h.ms.UpsertReplica(ctx, rr); err != nil {
				writeError(w, err)
				return
			}
		}
		// echo stored rows
		stored, err := h.ms.PullReplicas(ctx, uid, "", nil)
		if err != nil {
			writeError(w, err)
			return
		}
		out := make([]ReplicaRow, 0, len(stored))
		for _, rr := range stored {
			out = append(out, toReplicaRow(rr))
		}
		writeJSON(w, map[string]interface{}{"rows": out})
		return
	}

	if len(body.Cursors) > 0 {
		cursors := body.Cursors
		for i := range cursors {
			cursors[i].Kind = body.Cursors[i].Kind
		}
		results, err := h.ms.PullReplicasBatch(ctx, uid, cursors)
		if err != nil {
			writeError(w, err)
			return
		}
		type batchResult struct {
			Kind string       `json:"kind"`
			Rows []ReplicaRow `json:"rows"`
		}
		out := make([]batchResult, 0, len(results))
		for kind, rows := range results {
			br := batchResult{Kind: kind, Rows: make([]ReplicaRow, 0, len(rows))}
			for _, rr := range rows {
				br.Rows = append(br.Rows, toReplicaRow(rr))
			}
			out = append(out, br)
		}
		writeJSON(w, map[string]interface{}{"results": out})
		return
	}

	writeJSON(w, map[string]interface{}{"rows": []ReplicaRow{}})
}

// GET /api/sync/replica-keys
func (h *ReplicaHandler) KeysGet(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	rows, err := h.ms.ListReplicaKeys(r.Context(), uid)
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]ReplicaKeyRow, 0, len(rows))
	for _, k := range rows {
		out = append(out, ReplicaKeyRow{SaltID: k.SaltID, Alg: k.Alg, Salt: k.Salt, CreatedAt: k.CreatedAt})
	}
	writeJSON(w, map[string]interface{}{"rows": out})
}

// POST /api/sync/replica-keys  body {"alg": "..."}
func (h *ReplicaHandler) KeysPost(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	var body struct {
		Alg string `json:"alg"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Alg == "" {
		http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	saltID := randomHex(8)
	salt := randomHex(32)
	if err := h.ms.UpsertReplicaKey(r.Context(), uid, body.Alg, saltID, salt); err != nil {
		writeError(w, err)
		return
	}
	row, err := h.ms.ListReplicaKeys(r.Context(), uid)
	if err != nil {
		writeError(w, err)
		return
	}
	var created store.ReplicaKeyRow
	for _, k := range row {
		if k.SaltID == saltID {
			created = k
		}
	}
	writeJSON(w, map[string]interface{}{"row": ReplicaKeyRow{SaltID: created.SaltID, Alg: created.Alg, Salt: created.Salt, CreatedAt: created.CreatedAt}})
}

// DELETE /api/sync/replica-keys
func (h *ReplicaHandler) KeysDelete(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	if err := h.ms.DeleteReplicaKeys(r.Context(), uid); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func toReplicaRow(rr store.ReplicaRow) ReplicaRow {
	return ReplicaRow{
		UserID:        rr.UserID,
		Kind:          rr.Kind,
		ReplicaID:     rr.ReplicaID,
		FieldsJSONB:   json.RawMessage(rr.FieldsJSONB),
		ManifestJSONB: json.RawMessage(rr.ManifestJSONB),
		DeletedAtTS:   rr.DeletedAtTS,
		Reincarnation: rr.Reincarnation,
		UpdatedAtTS:   rr.UpdatedAtTS,
		SchemaVersion: rr.SchemaVersion,
	}
}

func jsonRaw(r json.RawMessage) []byte {
	if len(r) == 0 {
		return []byte("{}")
	}
	return []byte(r)
}
