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
	// A tombstone is never cleared by a row that predates it. A peer that had
	// not pulled the deletion yet can still hold a row whose only newer stamp is
	// page-turn progress; letting that row win resurrected the book on every
	// device. Only a row that is genuinely newer than the deletion may restore it.
	//
	// "Newer" must NOT be read off updated_at: page turns (sync.go
	// piggybackBookProgress) and uploads (storage.stampBookUpload) both bump it,
	// so a stale peer that read one page after the deletion would resurrect the
	// book. Only a real field edit made after the deletion counts.
	if existing.DeletedAt != nil && b.DeletedAt == nil && !restoredAfterTombstone(existing, b) {
		b.DeletedAt = existing.DeletedAt
		var serverData, clientData map[string]interface{}
		if json.Unmarshal(existing.Data, &serverData) == nil &&
			json.Unmarshal(b.Data, &clientData) == nil {
			if deleted, ok := serverData["deleted_at"].(string); ok && deleted != "" {
				clientData["deleted_at"] = deleted
			}
			if data, err := json.Marshal(clientData); err == nil {
				b.Data = data
			}
		}
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

// restoredAfterTombstone reports whether an incoming row carries evidence of a
// DELIBERATE restore made after the deletion, which is the only thing allowed to
// clear a tombstone. updated_at cannot be that evidence: page turns (sync.go
// piggybackBookProgress) and uploads (storage.stampBookUpload) both bump it, so
// a stale peer that merely read one page after the deletion would resurrect the
// book on every device — which is the bug this guard exists for.
func restoredAfterTombstone(existing *BookRow, b BookRow) bool {
	var serverData, clientData map[string]interface{}
	if json.Unmarshal(existing.Data, &serverData) != nil ||
		json.Unmarshal(b.Data, &clientData) != nil {
		return false
	}
	deletedAt, _ := serverData["deleted_at"].(string)
	if deletedAt == "" {
		return false
	}
	// 1. An explicit restore marker (newer clients set it when they clear
	//    deletedAt on re-import / re-upload).
	if ts, ok := clientData["restored_at"].(string); ok && ts > deletedAt {
		return true
	}
	// 2. A real field edit made after the deletion.
	for _, f := range []string{
		"metadata_updated_at", "cover_updated_at", "group_updated_at", "reading_status_updated_at",
	} {
		if ts, ok := clientData[f].(string); ok && ts > deletedAt {
			return true
		}
	}
	// 3. The book file itself was uploaded again after the deletion, which only
	//    re-import/re-upload does — a peer fetching it never pushes uploaded_at.
	if ts, ok := clientData["uploaded_at"].(string); ok && ts > deletedAt {
		return true
	}
	return false
}
