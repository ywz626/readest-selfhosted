package storage

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"readestsync/internal/middleware"
	"readestsync/internal/store"
)

type StorageHandler struct {
	ms         store.MetadataStore
	fs         store.FileStore
	quotaBytes int64
}

func NewStorageHandler(ms store.MetadataStore, fs store.FileStore, quotaBytes int64) *StorageHandler {
	if quotaBytes <= 0 {
		quotaBytes = 1 << 60
	}
	return &StorageHandler{ms: ms, fs: fs, quotaBytes: quotaBytes}
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
		return uid + "/replicas/" + body.ReplicaKind + "/" + body.ReplicaID + "/" + body.FileName
	}
	if body.BookHash != "" {
		return uid + "/books/" + body.BookHash + "/" + body.FileName
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
		if bookHash != "" && !strings.Contains(f.Key, "/books/"+bookHash+"/") {
			continue
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

// GET /api/storage/stats
// computeUsage sums the stored bytes of a user. Shared by Stats and the quota
// enforcement in BlobPut.
func (h *StorageHandler) computeUsage(ctx context.Context, uid string) (int64, error) {
	all, err := h.fs.List(uid + "/")
	if err != nil {
		return 0, err
	}
	var usage int64
	for _, f := range all {
		usage += f.Size
	}
	return usage, nil
}

func (h *StorageHandler) Stats(w http.ResponseWriter, r *http.Request) {
	uid := middleware.UserID(r)
	usage, err := h.computeUsage(r.Context(), uid)
	if err != nil {
		writeError(w, err)
		return
	}
	all, err := h.fs.List(uid + "/")
	if err != nil {
		writeError(w, err)
		return
	}
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
	if !strings.HasPrefix(key, uid+"/") {
		http.Error(w, `{"error":"forbidden","code":"AUTH"}`, http.StatusForbidden)
		return
	}
	if err := h.fs.Delete(r.Context(), key); err != nil {
		writeError(w, err)
		return
	}
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
		if !strings.HasPrefix(k, uid+"/") {
			failed = append(failed, map[string]string{"fileKey": k, "error": "forbidden"})
			continue
		}
		if err := h.fs.Delete(r.Context(), k); err != nil {
			failed = append(failed, map[string]string{"fileKey": k, "error": err.Error()})
		} else {
			success = append(success, k)
		}
	}
	writeJSON(w, map[string]interface{}{
		"success":      success,
		"failed":       failed,
		"deletedCount": len(success),
		"failedCount":  len(failed),
	})
}
