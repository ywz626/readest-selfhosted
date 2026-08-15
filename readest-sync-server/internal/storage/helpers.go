package storage

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"readestsync/internal/store"
)

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error(), "code": "SERVER"})
}

func bookHashFromKey(key string) *string {
	// expected: owner/books/<hash>/<file> or owner/replicas/...
	parts := strings.Split(key, "/")
	for i, p := range parts {
		if p == "books" && i+1 < len(parts) {
			v := parts[i+1]
			return &v
		}
	}
	return nil
}

func replicaInfoFromKey(key string) (kind, id *string) {
	// expected: owner/replicas/<kind>/<id>/<file>
	parts := strings.Split(key, "/")
	for i, p := range parts {
		if p == "replicas" && i+2 < len(parts) {
			k := parts[i+1]
			r := parts[i+2]
			return &k, &r
		}
	}
	return nil, nil
}

func sortFiles(files []store.FileMeta, by, order string) {
	asc := order != "desc"
	less := func(i, j int) bool {
		var a, b string
		switch by {
		case "size":
			if files[i].Size != files[j].Size {
				return files[i].Size < files[j].Size
			}
			a, b = files[i].Key, files[j].Key
		case "updated_at":
			if files[i].UpdatedAt != files[j].UpdatedAt {
				return files[i].UpdatedAt < files[j].UpdatedAt
			}
			a, b = files[i].Key, files[j].Key
		default:
			a, b = files[i].Key, files[j].Key
		}
		if asc {
			return a < b
		}
		return a > b
	}
	sort.Slice(files, less)
}
