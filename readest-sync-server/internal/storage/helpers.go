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
	// expected: owner/Readest/Books/<hash>/<file> (new) or owner/books/<hash>/<file> (legacy)
	parts := strings.Split(key, "/")
	for i, p := range parts {
		if p == "Books" && i > 0 && parts[i-1] == "Readest" && i+1 < len(parts) {
			v := parts[i+1]
			return &v
		}
	}
	for i, p := range parts {
		if p == "books" && i+1 < len(parts) {
			v := parts[i+1]
			return &v
		}
	}
	return nil
}

func replicaInfoFromKey(key string) (kind, id *string) {
	// expected: owner/Readest/Replicas/<kind>/<id>/<file> (new)
	// or owner/replicas/<kind>/<id>/<file> (legacy)
	parts := strings.Split(key, "/")
	for i, p := range parts {
		if p == "Replicas" && i > 0 && parts[i-1] == "Readest" && i+2 < len(parts) {
			k := parts[i+1]
			r := parts[i+2]
			return &k, &r
		}
	}
	for i, p := range parts {
		if p == "replicas" && i+2 < len(parts) {
			k := parts[i+1]
			r := parts[i+2]
			return &k, &r
		}
	}
	return nil, nil
}

// legacyStorageKey maps a new-format storage key back to the layout produced by
// buildKey before the key-format fix, so files uploaded by earlier server
// builds remain downloadable:
//
//	owner/Readest/Books/<hash>/<file>          -> owner/books/<hash>/Readest/Books/<hash>/<file>
//	owner/Readest/Replicas/<kind>/<id>/<file>  -> owner/replicas/<kind>/<id>/Readest/Replicas/<kind>/<id>/<file>
func legacyStorageKey(key string) (string, bool) {
	parts := strings.Split(key, "/")
	if len(parts) >= 4 && parts[1] == "Readest" && parts[2] == "Books" {
		return parts[0] + "/books/" + parts[3] + "/" + strings.Join(parts[1:], "/"), true
	}
	if len(parts) >= 5 && parts[1] == "Readest" && parts[2] == "Replicas" {
		return parts[0] + "/replicas/" + parts[3] + "/" + parts[4] + "/" + strings.Join(parts[1:], "/"), true
	}
	return "", false
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
