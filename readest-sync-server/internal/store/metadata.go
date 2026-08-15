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
	Data      []byte  // JSON of full BookRecord
}

type NoteRow struct {
	UserID    string
	NoteID    string
	UpdatedAt *int64
	DeletedAt *int64
	Data      []byte
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
	UserID     string
	BookHash   string
	Title      string
	Authors    string
	UpdatedAtMs *int64
	DeletedAt  *int64
}

type StatPageRow struct {
	UserID    string
	BookHash  string
	Page      int
	StartTime int64
	Duration  int64
	TotalPages int
	UpdatedAtMs *int64
	DeletedAt  *int64
}

type ReplicaKeyRow struct {
	SaltID    string
	Alg       string
	Salt      string
	CreatedAt string
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
