package store

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// jsonUnmarshalField decodes a single field from a JSON document into target.
func jsonUnmarshalField(data []byte, field string, target interface{}) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	raw, ok := m[field]
	if !ok {
		return nil
	}
	return json.Unmarshal(raw, target)
}

// nullableString returns "" for a nil []byte, else the string contents.
func nullableString(b []byte) string {
	if b == nil {
		return ""
	}
	return string(b)
}

// uniqueHlc returns the lexicographically greater of two HLCs (unused helper kept for clarity).
func uniqueHlc(a, b string) string {
	if a > b {
		return a
	}
	return b
}

var _ = uniqueHlc
var _ = hlcMax
var _ = fmt.Sprint
var _ = strings.TrimSpace

// resolveBookMerge applies the row- and field-level LWW rules and returns the
// final row to persist. It is shared by UpsertBook (single) and UpsertBooks
// (batched) so the two paths behave identically. existing may be nil when the
// book has never been synced before.
func resolveBookMerge(existing *BookRow, b BookRow) BookRow {
	if existing == nil {
		return b
	}
	clientNewer := false
	if b.DeletedAt != nil && (existing.DeletedAt == nil || *b.DeletedAt > *existing.DeletedAt) {
		clientNewer = true
	}
	if b.UpdatedAt != nil && (existing.UpdatedAt == nil || *b.UpdatedAt > *existing.UpdatedAt) {
		clientNewer = true
	}
	if clientNewer {
		// Incoming row wins wholesale; preserve the server's created_at
		// and any field-level values whose timestamp is >= the client's.
		// This prevents a peer's progress-only update (which bumps updated_at
		// but not metadataUpdatedAt) from silently dropping fields like
		// pinned_at that were set by another device on the metadata clock.
		var serverData, clientData map[string]interface{}
		if json.Unmarshal(existing.Data, &serverData) == nil && json.Unmarshal(b.Data, &clientData) == nil {
			if created, ok := serverData["created_at"]; ok {
				clientData["created_at"] = created
			}
			mergeBookFieldsClientWins(clientData, serverData)
			if bd, err := json.Marshal(clientData); err == nil {
				b.Data = bd
			}
		}
		return b
	}
	// Server row wins; graft the client's newer fields.
	var serverData, clientData map[string]interface{}
	if json.Unmarshal(existing.Data, &serverData) == nil && json.Unmarshal(b.Data, &clientData) == nil {
		merged, maxTS := mergeBookFields(serverData, clientData)
		if merged {
			if nd, err := json.Marshal(serverData); err == nil {
				existing.Data = nd
			}
			existing.SyncedAt = time.Now().UTC().Format(time.RFC3339)
			if maxTS != "" {
				if t, err := time.Parse(time.RFC3339, maxTS); err == nil {
					ms := t.UnixMilli()
					existing.UpdatedAt = &ms
				}
			}
		}
	}
	return *existing
}
