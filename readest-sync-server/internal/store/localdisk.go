package store

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type LocalDiskStore struct {
	root string
}

func NewLocalDiskStore(root string) (*LocalDiskStore, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &LocalDiskStore{root: root}, nil
}

func (f *LocalDiskStore) safePath(key string) (string, error) {
	clean := filepath.Clean("/" + key) // ensure no traversal outside root
	p := filepath.Join(f.root, clean)
	if !strings.HasPrefix(p, filepath.Clean(f.root)) {
		return "", fmt.Errorf("invalid key: %s", key)
	}
	return p, nil
}

func (f *LocalDiskStore) Put(ctx context.Context, key string, r io.Reader, size int64) error {
	p, err := f.safePath(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	out, err := os.Create(p)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, r)
	return err
}

func (f *LocalDiskStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	p, err := f.safePath(key)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

// limitedReadCloser wraps a range-limited reader and closes the underlying file.
type limitedReadCloser struct {
	io.Reader
	closer io.Closer
}

func (l *limitedReadCloser) Close() error { return l.closer.Close() }

// GetRange returns a reader for [offset, offset+length) of the object plus its
// total size. A non-positive length reads through the end of the object.
func (f *LocalDiskStore) GetRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, int64, error) {
	p, err := f.safePath(key)
	if err != nil {
		return nil, 0, err
	}
	file, err := os.Open(p)
	if err != nil {
		return nil, 0, err
	}
	st, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, 0, err
	}
	total := st.Size()
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	end := total
	if length > 0 && offset+length < end {
		end = offset + length
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		file.Close()
		return nil, 0, err
	}
	return &limitedReadCloser{Reader: io.LimitReader(file, end-offset), closer: file}, total, nil
}

func (f *LocalDiskStore) Delete(ctx context.Context, key string) error {
	p, err := f.safePath(key)
	if err != nil {
		return err
	}
	err = os.Remove(p)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func (f *LocalDiskStore) UploadURL(key string) string {
	return "/api/storage/blob/" + key
}

func (f *LocalDiskStore) DownloadURL(key string) string {
	return "/api/storage/blob/" + key
}

func (f *LocalDiskStore) List(prefix string) ([]FileMeta, error) {
	var out []FileMeta
	base := filepath.Join(f.root, filepath.Clean("/"+prefix))
	if prefix == "" {
		base = f.root
	}
	err := filepath.Walk(base, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(f.root, path)
		if err != nil {
			return nil
		}
		key := filepath.ToSlash(rel)
		out = append(out, FileMeta{
			Key:       key,
			Size:      info.Size(),
			UpdatedAt: info.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}
