package storage

import (
	"io"
	"net/http"
	"strings"

	"readestsync/internal/middleware"
)

// blobKeyPrefix is stripped from the request path to recover the storage key.
const blobKeyPrefix = "/api/storage/blob/"

// PUT /api/storage/blob/<key>  (key form: owner/Readest/Books/<hash>/<file>)
func (h *StorageHandler) BlobPut(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, blobKeyPrefix)
	uid := middleware.UserID(r)
	if !strings.HasPrefix(key, uid+"/") {
		http.Error(w, `{"error":"forbidden","code":"AUTH"}`, http.StatusForbidden)
		return
	}
	// Enforce the storage quota before accepting the body so a misbehaving or
	// compromised client cannot fill the disk.
	if r.ContentLength > 0 {
		used, err := h.computeUsage(r.Context(), uid)
		if err != nil {
			http.Error(w, `{"error":"usage check failed","code":"SERVER"}`, http.StatusInternalServerError)
			return
		}
		if used+r.ContentLength > h.quotaBytes {
			http.Error(w, `{"error":"storage quota exceeded","code":"QUOTA_EXCEEDED"}`, http.StatusRequestEntityTooLarge)
			return
		}
	}
	if err := h.fs.Put(r.Context(), key, r.Body, r.ContentLength); err != nil {
		http.Error(w, `{"error":"put failed","code":"SERVER"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// GET /api/storage/blob/<key>
func (h *StorageHandler) BlobGet(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, blobKeyPrefix)
	uid := middleware.UserID(r)
	if !strings.HasPrefix(key, uid+"/") {
		http.Error(w, "", http.StatusForbidden)
		return
	}
	rc, err := h.fs.Get(r.Context(), key)
	if err != nil {
		// Backward compatibility: files uploaded before the key-format fix live
		// under owner/books/<hash>/Readest/Books/<hash>/<file> (replicas: same
		// nesting under owner/replicas/...). Try that legacy location too.
		if legacy, ok := legacyStorageKey(key); ok {
			rc, err = h.fs.Get(r.Context(), legacy)
		}
		if err != nil {
			http.Error(w, "", http.StatusNotFound)
			return
		}
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	io.Copy(w, rc)
}
