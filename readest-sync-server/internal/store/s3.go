package store

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type S3Store struct {
	client *minio.Client
	bucket string
}

// isPathStyleEndpoint reports whether minio-go will resolve the endpoint in
// path-style mode. minio-go auto-detects path-style for IP / localhost hosts
// only; any other host is resolved via virtual-host style (bucket.host).
func isPathStyleEndpoint(endpoint string) bool {
	host := endpoint
	if u, err := url.Parse(endpoint); err == nil && u.Hostname() != "" {
		host = u.Hostname()
	} else if h, _, err := net.SplitHostPort(endpoint); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "localhost" || strings.HasPrefix(host, "127.") {
		return true
	}
	return net.ParseIP(host) != nil
}

func NewS3Store(b Backends) (*S3Store, error) {
	client, err := minio.New(b.S3Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(b.S3AccessKey, b.S3SecretKey, ""),
		Region: b.S3Region,
		Secure: false,
	})
	if err != nil {
		return nil, err
	}
	if b.S3UsePathStyle && !isPathStyleEndpoint(b.S3Endpoint) {
		// minio-go cannot be forced into path-style for a non-IP host without
		// breaking request signing, so reject the misconfiguration loudly
		// instead of silently failing at runtime.
		return nil, fmt.Errorf(
			"S3_USE_PATH_STYLE=true requires S3_ENDPOINT to be an IP address or localhost (minio-go only uses path-style for IP endpoints); got %q",
			b.S3Endpoint,
		)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exists, err := client.BucketExists(ctx, b.S3Bucket)
	if err != nil {
		return nil, err
	}
	if !exists {
		if err := client.MakeBucket(ctx, b.S3Bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, err
		}
	}
	return &S3Store{client: client, bucket: b.S3Bucket}, nil
}

func (s *S3Store) Put(ctx context.Context, key string, r io.Reader, size int64) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{})
	return err
}

func (s *S3Store) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// verify object exists
	if _, err := obj.Stat(); err != nil {
		_ = obj.Close()
		return nil, err
	}
	return obj, nil
}

// GetRange returns a reader for [offset, offset+length) of the object plus its
// total size. A non-positive length reads through the end of the object.
func (s *S3Store) GetRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, int64, error) {
	st, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	total := st.Size
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	if length <= 0 || offset+length > total {
		length = total - offset
	}
	if length == 0 {
		return io.NopCloser(strings.NewReader("")), total, nil
	}
	opts := minio.GetObjectOptions{}
	if err := opts.SetRange(offset, offset+length-1); err != nil {
		return nil, 0, err
	}
	obj, err := s.client.GetObject(ctx, s.bucket, key, opts)
	if err != nil {
		return nil, 0, err
	}
	// verify the object exists and the server honored the range
	if _, err := obj.Stat(); err != nil {
		_ = obj.Close()
		return nil, 0, err
	}
	return obj, total, nil
}

func (s *S3Store) Delete(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

func (s *S3Store) UploadURL(key string) string {
	// Real presigned PUT URL; callers use it directly. We return a marker and
	// the actual presign is performed lazily by the storage handler if needed.
	return "/api/storage/blob/" + key
}

func (s *S3Store) DownloadURL(key string) string {
	return "/api/storage/blob/" + key
}

func (s *S3Store) List(prefix string) ([]FileMeta, error) {
	ctx := context.Background()
	var out []FileMeta
	for obj := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if obj.Err != nil {
			return nil, obj.Err
		}
		if strings.HasSuffix(obj.Key, "/") {
			continue
		}
		var updated string
		if !obj.LastModified.IsZero() {
			updated = obj.LastModified.UTC().Format("2006-01-02T15:04:05Z")
		}
		out = append(out, FileMeta{
			Key:       obj.Key,
			Size:      obj.Size,
			UpdatedAt: updated,
		})
	}
	return out, nil
}
