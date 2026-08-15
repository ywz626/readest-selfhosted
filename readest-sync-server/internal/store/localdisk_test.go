package store

import (
	"bytes"
	"context"
	"io"
	"testing"
)

func TestLocalDiskPutGet(t *testing.T) {
	fs, err := NewLocalDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := fs.Put(ctx, "owner/books/h1.epub", bytes.NewReader([]byte("hello")), 5); err != nil {
		t.Fatal(err)
	}
	rc, err := fs.Get(ctx, "owner/books/h1.epub")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	data, _ := io.ReadAll(rc)
	if string(data) != "hello" {
		t.Fatalf("got %q", data)
	}
}
