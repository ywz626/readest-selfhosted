package storage

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"readestsync/internal/middleware"
	"readestsync/internal/store"
)

type StorageHandler struct {
	ms         store.MetadataStore
	fs         store.FileStore
	quotaBytes int64

	usageMu    sync.Mutex
	usageCache map[string]usageEntry
}

// usageEntry is a cached quota measurement together with the time it was
// taken.
type usageEntry struct {
	used int64
	at   time.Time
}

// usageCacheTTL bounds how stale a cached quota measurement may be. The
// quota check runs on every upload, and measuring the usage means listing
// the whole user tree — O(files) per upload, which made a batch upload walk
// the tree once per book. A short-lived cache turns that into an O(1)
// lookup; the cost is that a user may exceed the soft quota by at most what
// they upload within the TTL.
const usageCacheTTL = 5 * time.Second

func NewStorageHandler(ms store.MetadataStore, fs store.FileStore, quotaBytes int64) *StorageHandler {
	if quotaBytes <= 0 {
		quotaBytes = 1 << 60
	}
	return &StorageHandler{
		ms:         ms,
		fs:         fs,
		quotaBytes: quotaBytes,
		usageCache: make(map[string]usageEntry),
	}
}

// POST /api/storage/upload  body {"fileName","fileSize","bookHash?","replicaKind?","replicaId?","temp?","media?"}
func (h *StorageHandler) Upload(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	var body struct {
		FileName    string `json:"fileName"`
		FileSize    int64  `json:"fileSize"`
		BookHash    string `json:"bookHash"`
		ReplicaKind string `json:"replicaKind"`
		ReplicaID   string `json:"replicaId"`
		Temp        bool   `json:"temp"`
		Media       string `json:"media"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	key := buildKey(uid, body)
	resp := map[string]string{
		"uploadUrl": h.fs.UploadURL(key),
	}
	if dl := h.fs.DownloadURL(key); dl != "" {
		resp["downloadUrl"] = dl
	}
	writeJSON(w, resp)
}

// buildKey maps an upload request to its storage key.
//
// The Readest client always sends a fully-formed cloud file path in FileName,
// identical to the "cfp" it later uses to build download keys (uid + "/" + cfp):
//
//	book/cover uploads: fileName = Readest/Books/<hash>/<file>
//	replica uploads:    fileName = Readest/Replicas/<kind>/<id>/<file>
//
// So the stored key MUST be uid + "/" + FileName verbatim. Any prefix rewriting
// here (e.g. the old uid/books/<hash>/<fileName> layout) silently breaks every
// download: the client looks up uid/Readest/Books/<hash>/<file> and gets a 404.
func buildKey(uid string, body struct {
	FileName    string `json:"fileName"`
	FileSize    int64  `json:"fileSize"`
	BookHash    string `json:"bookHash"`
	ReplicaKind string `json:"replicaKind"`
	ReplicaID   string `json:"replicaId"`
	Temp        bool   `json:"temp"`
	Media       string `json:"media"`
}) string {
	if body.ReplicaKind != "" && body.ReplicaID != "" {
		return uid + "/" + body.FileName
	}
	if body.BookHash != "" {
		return uid + "/" + body.FileName
	}
	if body.Temp {
		return uid + "/temp/" + body.FileName
	}
	return uid + "/files/" + body.FileName
}

// GET /api/storage/download?fileKey=
func (h *StorageHandler) Download(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("fileKey")
	if key == "" {
		http.Error(w, `{"error":"missing fileKey","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]string{"downloadUrl": h.fs.DownloadURL(key)})
}

// POST /api/storage/download  body {"fileKeys":[...]}
func (h *StorageHandler) DownloadBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FileKeys []string `json:"fileKeys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	out := make(map[string]string, len(body.FileKeys))
	for _, k := range body.FileKeys {
		out[k] = h.fs.DownloadURL(k)
	}
	writeJSON(w, map[string]interface{}{"downloadUrls": out})
}

// GET /api/storage/list
func (h *StorageHandler) List(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(q.Get("pageSize"))
	if pageSize < 1 {
		pageSize = 50
	}
	sortBy := q.Get("sortBy")
	if sortBy == "" {
		sortBy = "key"
	}
	sortOrder := q.Get("sortOrder")
	if sortOrder == "" {
		sortOrder = "asc"
	}
	bookHash := q.Get("bookHash")
	search := q.Get("search")

	all, err := h.fs.List(uid + "/")
	if err != nil {
		writeError(w, err)
		return
	}
	// filter
	filtered := make([]store.FileMeta, 0, len(all))
	for _, f := range all {
		if bookHash != "" {
			matched := strings.Contains(f.Key, "/Readest/Books/"+bookHash+"/") ||
				strings.Contains(f.Key, "/books/"+bookHash+"/")
			if !matched {
				continue
			}
		}
		if search != "" && !strings.Contains(f.Key, search) {
			continue
		}
		filtered = append(filtered, f)
	}
	// sort
	sortFiles(filtered, sortBy, sortOrder)
	total := len(filtered)
	totalPages := (total + pageSize - 1) / pageSize
	if totalPages < 1 {
		totalPages = 1
	}
	start := (page - 1) * pageSize
	if start > total {
		start = total
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	pageItems := filtered[start:end]

	files := make([]map[string]interface{}, 0, len(pageItems))
	for _, f := range pageItems {
		bh := bookHashFromKey(f.Key)
		rk, rid := replicaInfoFromKey(f.Key)
		files = append(files, map[string]interface{}{
			"file_key":     f.Key,
			"file_size":    f.Size,
			"book_hash":    bh,
			"replica_kind": rk,
			"replica_id":   rid,
			"created_at":   f.UpdatedAt,
			"updated_at":   f.UpdatedAt,
		})
	}
	writeJSON(w, map[string]interface{}{
		"files":      files,
		"total":      total,
		"page":       page,
		"pageSize":   pageSize,
		"totalPages": totalPages,
	})
}

// computeUsage sums the stored bytes of a user. Shared by Stats and the quota
// enforcement in BlobPut.
//
// The measurement itself lists the whole user tree, so the result is cached
// for a few seconds: BlobPut asks for it on every single upload, and without
// the cache a batch upload walked the entire tree once per book.
func (h *StorageHandler) computeUsage(ctx context.Context, uid string) (int64, error) {
	h.usageMu.Lock()
	if entry, ok := h.usageCache[uid]; ok && time.Since(entry.at) < usageCacheTTL {
		h.usageMu.Unlock()
		return entry.used, nil
	}
	h.usageMu.Unlock()

	all, err := h.fs.List(uid + "/")
	if err != nil {
		return 0, err
	}
	usage := sumSizes(all)

	h.usageMu.Lock()
	h.usageCache[uid] = usageEntry{used: usage, at: time.Now()}
	h.usageMu.Unlock()
	return usage, nil
}

// sumSizes adds up the size of every listed file.
func sumSizes(all []store.FileMeta) int64 {
	var usage int64
	for _, f := range all {
		usage += f.Size
	}
	return usage
}

// invalidateUsage drops the cached quota measurement of a user, so a delete
// is reflected in the next quota check instead of after the cache expires.
func (h *StorageHandler) invalidateUsage(uid string) {
	h.usageMu.Lock()
	delete(h.usageCache, uid)
	h.usageMu.Unlock()
}

// addCachedUsage folds newly stored bytes into the cached quota measurement,
// so consecutive uploads inside the cache window are checked against the
// real usage. A cache miss is left alone: the next measurement reads the
// tree anyway.
func (h *StorageHandler) addCachedUsage(uid string, size int64) {
	if size <= 0 {
		return
	}
	h.usageMu.Lock()
	if entry, ok := h.usageCache[uid]; ok {
		h.usageCache[uid] = usageEntry{used: entry.used + size, at: time.Now()}
	}
	h.usageMu.Unlock()
}

// GET /api/storage/stats
func (h *StorageHandler) Stats(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	all, err := h.fs.List(uid + "/")
	if err != nil {
		writeError(w, err)
		return
	}
	// The stats page reports the exact usage, so it measures the tree
	// directly instead of using the cached value the quota check reads.
	usage := sumSizes(all)
	byBook := map[string]struct {
		FileCount int64
		TotalSize int64
	}{}
	for _, f := range all {
		bh := bookHashFromKey(f.Key)
		key := ""
		if bh != nil {
			key = *bh
		}
		e := byBook[key]
		e.FileCount++
		e.TotalSize += f.Size
		byBook[key] = e
	}
	quota := h.quotaBytes
	pct := float64(usage) / float64(quota) * 100
	byBookArr := make([]map[string]interface{}, 0, len(byBook))
	for bh, v := range byBook {
		byBookArr = append(byBookArr, map[string]interface{}{
			"bookHash":  bh,
			"fileCount": v.FileCount,
			"totalSize": v.TotalSize,
		})
	}
	writeJSON(w, map[string]interface{}{
		"totalFiles":      len(all),
		"totalSize":       usage,
		"usage":           usage,
		"quota":           quota,
		"usagePercentage": pct,
		"byBookHash":      byBookArr,
	})
}

// DELETE /api/storage/delete?fileKey=
func (h *StorageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("fileKey")
	uid := middleware.UserID(r)
	if key == "" {
		http.Error(w, `{"error":"missing fileKey","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	// Scope deletes to the caller's own key space, mirroring BlobPut/BlobGet.
	if !validUserKey(uid, key) {
		http.Error(w, `{"error":"forbidden","code":"AUTH"}`, http.StatusForbidden)
		return
	}
	if err := h.fs.Delete(r.Context(), key); err != nil {
		writeError(w, err)
		return
	}
	h.invalidateUsage(uid)
	w.WriteHeader(http.StatusOK)
}

// DELETE /api/storage/purge  body {"fileKeys":[...]}
func (h *StorageHandler) Purge(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	var body struct {
		FileKeys []string `json:"fileKeys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad request","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	success := make([]string, 0, len(body.FileKeys))
	failed := make([]map[string]string, 0)
	for _, k := range body.FileKeys {
		// Scope deletes to the caller's own key space, mirroring BlobPut/BlobGet.
		if !validUserKey(uid, k) {
			failed = append(failed, map[string]string{"fileKey": k, "error": "forbidden"})
			continue
		}
		if err := h.fs.Delete(r.Context(), k); err != nil {
			failed = append(failed, map[string]string{"fileKey": k, "error": err.Error()})
		} else {
			success = append(success, k)
		}
	}
	if len(success) > 0 {
		h.invalidateUsage(uid)
	}
	writeJSON(w, map[string]interface{}{
		"success":      success,
		"failed":       failed,
		"deletedCount": len(success),
		"failedCount":  len(failed),
	})
}
