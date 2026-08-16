package store

import (
	"context"
	"fmt"
	"strings"
)

// Backends holds the configuration needed to construct storage backends.
// It is decoupled from the main Config to avoid an import cycle.
type Backends struct {
	MetadataBackend string // "sqlite" | "postgres"
	MetadataDSN     string // sqlite file path or postgres URL
	StorageKind     string // "local" | "s3"
	LocalRoot       string
	S3Endpoint      string
	S3Bucket        string
	S3AccessKey     string
	S3SecretKey     string
	S3Region        string
	S3UsePathStyle  bool
}

type BookRow struct {
	ID        string
	UserID    string
	BookHash  string
	MetaHash  string
	UpdatedAt *int64  // epoch ms
	DeletedAt *int64
	SyncedAt  string  // ISO
	Data      []byte  // DB-shaped BookRecord JSON (see sync/transform.go)
}

type ReplicaRow struct {
	UserID        string
	Kind          string
	ReplicaID     string
	FieldsJSONB   []byte
	ManifestJSONB []byte
	DeletedAtTS   *string // Hlc
	Reincarnation *string
	UpdatedAtTS   string // Hlc
	SchemaVersion int
}

type StatBookRow struct {
	UserID      string  `json:"user_id"`
	BookHash    string  `json:"book_hash"`
	Title       string  `json:"title"`
	Authors     string  `json:"authors"`
	UpdatedAtMs *int64  `json:"updated_at_ms"`
	DeletedAt   *int64  `json:"deleted_at"`
}

type StatPageRow struct {
	UserID      string `json:"user_id"`
	BookHash    string `json:"book_hash"`
	Page        int    `json:"page"`
	StartTime   int64  `json:"start_time"`
	Duration    int64  `json:"duration"`
	TotalPages  int64  `json:"total_pages"`
	UpdatedAtMs *int64 `json:"updated_at_ms"`
	DeletedAt   *int64 `json:"deleted_at"`
}

type ReplicaKeyRow struct {
	SaltID    string `json:"saltId"`
	Alg       string `json:"alg"`
	Salt      string `json:"salt"`
	CreatedAt string `json:"createdAt"`
}

type ReplicaCursor struct {
	Kind  string
	Since *string
}

type FileMeta struct {
	Key       string
	Size      int64
	BookHash  *string
	UpdatedAt string
}

type MetadataStore interface {
	UpsertBook(ctx context.Context, b BookRow) error
	GetBook(ctx context.Context, userID, bookHash string) (*BookRow, error)
	PullBooks(ctx context.Context, userID string, sinceISO string, limit int) ([]BookRow, error)
	UpsertNote(ctx context.Context, userID string, data []byte) error
	PullNotes(ctx context.Context, userID string, sinceMs int64) ([][]byte, error)
	UpsertConfig(ctx context.Context, userID string, data []byte) error
	PullConfigs(ctx context.Context, userID string, sinceMs int64) ([][]byte, error)
	UpsertStatBooks(ctx context.Context, rows []StatBookRow) error
	PullStatBooks(ctx context.Context, userID string, sinceMs int64) ([]StatBookRow, error)
	UpsertStatPages(ctx context.Context, rows []StatPageRow) error
	PullStatPages(ctx context.Context, userID string, sinceMs int64) ([]StatPageRow, error)
	UpsertReplica(ctx context.Context, r ReplicaRow) error
	PullReplicas(ctx context.Context, userID, kind string, sinceHlc *string) ([]ReplicaRow, error)
	PullReplicasBatch(ctx context.Context, userID string, cursors []ReplicaCursor) (map[string][]ReplicaRow, error)
	UpsertReplicaKey(ctx context.Context, userID, alg, saltID, salt string) error
	ListReplicaKeys(ctx context.Context, userID string) ([]ReplicaKeyRow, error)
	DeleteReplicaKeys(ctx context.Context, userID string) error
}

// NewMetadataStore constructs the configured metadata backend.
func NewMetadataStore(b Backends) (MetadataStore, error) {
	switch b.MetadataBackend {
	case "postgres":
		return NewPostgresStore(b.MetadataDSN)
	case "sqlite", "":
		dsn := strings.TrimPrefix(b.MetadataDSN, "file:")
		return NewSqliteStore(dsn)
	default:
		return nil, fmt.Errorf("unknown METADATA_BACKEND=%q", b.MetadataBackend)
	}
}
