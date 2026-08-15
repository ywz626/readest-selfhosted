package proxy

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
)

// MetadataSearch proxies to Open Library (free, no key required).
func MetadataSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, `{"error":"missing q","code":"VALIDATION"}`, http.StatusBadRequest)
		return
	}
	u := "https://openlibrary.org/search.json?q=" + url.QueryEscape(q) + "&limit=20"
	resp, err := http.Get(u)
	if err != nil {
		writeError(w, err)
		return
	}
	defer resp.Body.Close()
	var ol struct {
		Docs []struct {
			Title       string   `json:"title"`
			AuthorName  []string `json:"author_name"`
			CoverI      int64    `json:"cover_i"`
			FirstPublishYear int64 `json:"first_publish_year"`
			ISBN        []string `json:"isbn"`
		} `json:"docs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ol); err != nil {
		writeError(w, err)
		return
	}
	out := make([]map[string]interface{}, 0, len(ol.Docs))
	for _, d := range ol.Docs {
		cover := ""
		if d.CoverI != 0 {
			cover = "https://covers.openlibrary.org/b/id/" + strconv.FormatInt(d.CoverI, 10) + "-L.jpg"
		}
		out = append(out, map[string]interface{}{
			"title":         d.Title,
			"authors":       d.AuthorName,
			"cover":         cover,
			"publish_year":  d.FirstPublishYear,
			"identifiers":   map[string]interface{}{"isbn": d.ISBN},
		})
	}
	writeJSON(w, map[string]interface{}{"results": out})
}
