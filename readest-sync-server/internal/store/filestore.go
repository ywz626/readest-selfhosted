package store

import (
	"context"
	"fmt"
	"io"
)

type FileStore interface {
	Put(ctx context.Context, key string, r io.Reader, size int64) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	// UploadURL returns a URL the client can PUT directly (for S3). For local, returns a local blob route.
	UploadURL(key string) string
	// DownloadURL returns a URL the client can GET directly.
	DownloadURL(key string) string
	List(prefix string) ([]FileMeta, error)
}

// NewFileStore constructs the configured file backend.
func NewFileStore(b Backends) (FileStore, error) {
	switch b.StorageKind {
	case "s3":
		return NewS3Store(b)
	case "local", "":
		return NewLocalDiskStore(b.LocalRoot)
	default:
		return nil, fmt.Errorf("unknown STORAGE_KIND=%q", b.StorageKind)
	}
}
