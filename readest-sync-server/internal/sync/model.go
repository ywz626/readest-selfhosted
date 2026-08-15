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

// Client sends stat rows in camelCase; we convert them to the snake_case
// store rows that the pull response also expects.
type statBookWire struct {
	BookHash    string  `json:"bookHash"`
	Title       string  `json:"title"`
	Authors     string  `json:"authors"`
	UpdatedAtMs *int64  `json:"updatedAtMs"`
	DeletedAt   *int64  `json:"deletedAt"`
}

type statPageWire struct {
	BookHash    string  `json:"bookHash"`
	Page        int     `json:"page"`
	StartTime   int64   `json:"startTime"`
	Duration    int64   `json:"duration"`
	TotalPages  int64   `json:"totalPages"`
	UpdatedAtMs *int64  `json:"updatedAtMs"`
	DeletedAt   *int64  `json:"deletedAt"`
}
