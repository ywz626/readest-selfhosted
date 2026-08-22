package storage

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
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

// parseRangeHeader parses a single "bytes=" Range header into a start offset
// and length (<=0 means "to end of file"). Returns ranged=false when the header
// is absent, malformed, or uses a form we do not support (suffix / multi-range),
// in which case the caller serves the whole object (valid per RFC 9110 §14.2).
func parseRangeHeader(header string) (offset, length int64, ranged bool) {
	if header == "" || !strings.HasPrefix(header, "bytes=") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(header, "bytes=")
	if strings.Contains(spec, ",") {
		return 0, 0, false // multi-range not supported; serve whole object
	}
	parts := strings.SplitN(spec, "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	// Suffix range "bytes=-N" needs the total size to resolve; the Readest
	// client always sends "bytes=start-end", so serve the whole object instead.
	if parts[0] == "" {
		return 0, 0, false
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 {
		return 0, 0, false
	}
	if parts[1] == "" {
		return start, -1, true
	}
	end, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || end < start {
		return 0, 0, false
	}
	return start, end - start + 1, true
}

// GET /api/storage/blob/<key>
// Supports HTTP Range requests (single range) so clients can resume and
// multi-thread downloads. Without it, reverse proxies answer the Range probe
// themselves while the origin ignores it, which silently corrupts chunked
// downloads.
func (h *StorageHandler) BlobGet(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, blobKeyPrefix)
	uid := middleware.UserID(r)
	if !strings.HasPrefix(key, uid+"/") {
		http.Error(w, "", http.StatusForbidden)
		return
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Type", "application/octet-stream")

	offset, length, ranged := parseRangeHeader(r.Header.Get("Range"))

	rc, total, err := h.fs.GetRange(r.Context(), key, offset, length)
	if err != nil {
		// Backward compatibility: files uploaded before the key-format fix live
		// under owner/books/<hash>/Readest/Books/<hash>/<file> (replicas: same
		// nesting under owner/replicas/...). Try that legacy location too.
		if legacy, ok := legacyStorageKey(key); ok {
			rc, total, err = h.fs.GetRange(r.Context(), legacy, offset, length)
		}
		if err != nil {
			http.Error(w, "", http.StatusNotFound)
			return
		}
	}
	defer rc.Close()

	if !ranged {
		w.Header().Set("Content-Length", strconv.FormatInt(total, 10))
		io.Copy(w, rc)
		return
	}

	// Range request: reject unsatisfiable ranges and clamp length to the file.
	if offset >= total {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if length <= 0 || offset+length > total {
		length = total - offset
	}
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+length-1, total))
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(http.StatusPartialContent)
	io.CopyN(w, rc, length)
}
