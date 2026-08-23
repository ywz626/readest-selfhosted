package sync

import (
	"encoding/json"

	"readestsync/internal/store"
)

// SyncResult is the response shape for GET /api/sync.
type SyncResult struct {
	Books     []json.RawMessage    `json:"books"`
	Notes     []json.RawMessage    `json:"notes"`
	Configs   []json.RawMessage    `json:"configs"`
	StatBooks []store.StatBookRow  `json:"statBooks"`
	StatPages []store.StatPageRow  `json:"statPages"`
}

// ReplicaRow mirrors the client replica contract.
type ReplicaRow struct {
	UserID        string          `json:"user_id"`
	Kind          string          `json:"kind"`
	ReplicaID     string          `json:"replica_id"`
	FieldsJSONB   json.RawMessage `json:"fields_jsonb"`
	ManifestJSONB json.RawMessage `json:"manifest_jsonb"`
	DeletedAtTS   *string         `json:"deleted_at_ts"`
	Reincarnation *string         `json:"reincarnation"`
	UpdatedAtTS   string          `json:"updated_at_ts"`
	SchemaVersion int             `json:"schema_version"`
}

type ReplicaKeyRow struct {
	SaltID    string `json:"saltId"`
	Alg       string `json:"alg"`
	Salt      string `json:"salt"`
	CreatedAt string `json:"createdAt"`
}

// Client pushes stat rows in snake_case (StatBookRecord / StatPageRecord in
// apps/readest-app/src/libs/sync.ts, populated by statsSync.ts toWireBook /
// toWirePage) — the same shape the pull response returns. The previous
// camelCase tags silently dropped every pushed row (Go's decoder ignores
// unknown fields → empty BookHash → skipped), so no stats ever landed.
type statBookWire struct {
	BookHash    string  `json:"book_hash"`
	Title       string  `json:"title"`
	Authors     string  `json:"authors"`
	UpdatedAtMs *int64  `json:"updated_at_ms"`
	DeletedAt   *int64  `json:"deleted_at"`
}

type statPageWire struct {
	BookHash    string  `json:"book_hash"`
	Page        int     `json:"page"`
	StartTime   int64   `json:"start_time"`
	Duration    int64   `json:"duration"`
	TotalPages  int64   `json:"total_pages"`
	UpdatedAtMs *int64  `json:"updated_at_ms"`
	DeletedAt   *int64  `json:"deleted_at"`
}
