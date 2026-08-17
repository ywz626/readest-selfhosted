package sync

import (
	"encoding/json"
	"strings"
	"time"
)

// The client pushes records in its in-memory shape (camelCase fields, `metadata`
// as a plain object, timestamps as epoch-ms), but on pull it parses records in
// DB shape (snake_case fields, JSON sub-objects serialized as strings, ISO-8601
// timestamps) via transformBookFromDB / transformBookConfigFromDB /
// transformBookNoteFromDB (apps/readest-app/src/utils/transform.ts).
//
// Storing the pushed payload verbatim (the previous behavior) makes the client
// feed an object to JSON.parse(metadata) -> `"[object Object]" is not valid
// JSON` and crash the whole app on every pull. These types/helpers convert
// pushed records to DB shape before storage, mirroring the official Readest
// sync server.

// sanitize strips the NUL character, mirroring utils/sanitize.ts sanitizeString.
func sanitize(s string) string {
	return strings.ReplaceAll(s, "\u0000", "")
}

// epochMsToISO converts a client epoch-ms timestamp to an ISO-8601 string.
func epochMsToISO(ms *int64) *string {
	if ms == nil {
		return nil
	}
	s := time.UnixMilli(*ms).UTC().Format(time.RFC3339)
	return &s
}

// rawOrNil keeps a raw JSON sub-value as a string (e.g. metadata object ->
// metadata JSON string). Absent and null values become nil.
func rawOrNil(r json.RawMessage) *string {
	if len(r) == 0 || string(r) == "null" {
		return nil
	}
	s := string(r)
	return &s
}

// pushedBook mirrors the client Book record pushed to /api/sync
// (apps/readest-app/src/types/book.ts).
type pushedBook struct {
	Hash                   string          `json:"hash"`
	MetaHash               string          `json:"metaHash"`
	Format                 string          `json:"format"`
	Title                  string          `json:"title"`
	SourceTitle            string          `json:"sourceTitle"`
	Author                 string          `json:"author"`
	GroupID                string          `json:"groupId"`
	GroupName              string          `json:"groupName"`
	Tags                   []string        `json:"tags"`
	Progress               json.RawMessage `json:"progress"`
	ReadingStatus          string          `json:"readingStatus"`
	ReadingStatusUpdatedAt *int64          `json:"readingStatusUpdatedAt"`
	CoverHash              *string         `json:"coverHash"`
	CoverUpdatedAt         *int64          `json:"coverUpdatedAt"`
	Metadata               json.RawMessage `json:"metadata"`
	MetadataUpdatedAt      *int64          `json:"metadataUpdatedAt"`
	CreatedAt              *int64          `json:"createdAt"`
	UpdatedAt              *int64          `json:"updatedAt"`
	DeletedAt              *int64          `json:"deletedAt"`
	UploadedAt             *int64          `json:"uploadedAt"`
	PinnedAt               *int64          `json:"pinnedAt"`
}

// dbBook is the DB-shaped book record returned on pull; the client parses it
// with transformBookFromDB.
type dbBook struct {
	UserID                 string          `json:"user_id"`
	BookHash               string          `json:"book_hash"`
	MetaHash               string          `json:"meta_hash,omitempty"`
	Format                 string          `json:"format"`
	Title                  string          `json:"title"`
	SourceTitle            string          `json:"source_title,omitempty"`
	Author                 string          `json:"author"`
	GroupID                string          `json:"group_id,omitempty"`
	GroupName              string          `json:"group_name,omitempty"`
	Tags                   []string        `json:"tags,omitempty"`
	Progress               json.RawMessage `json:"progress,omitempty"`
	ReadingStatus          string          `json:"reading_status,omitempty"`
	ReadingStatusUpdatedAt *string         `json:"reading_status_updated_at,omitempty"`
	CoverHash              *string         `json:"cover_hash,omitempty"`
	CoverUpdatedAt         *string         `json:"cover_updated_at,omitempty"`
	Metadata               *string         `json:"metadata"`
	MetadataUpdatedAt      *string         `json:"metadata_updated_at,omitempty"`
	CreatedAt              string          `json:"created_at"`
	UpdatedAt              string          `json:"updated_at"`
	DeletedAt              *string         `json:"deleted_at,omitempty"`
	UploadedAt             *string         `json:"uploaded_at,omitempty"`
	PinnedAt               *string         `json:"pinned_at,omitempty"`
	SyncedAt               string          `json:"synced_at"`
}

func bookToDB(p *pushedBook, uid, syncedAt string) *dbBook {
	created, updated := p.CreatedAt, p.UpdatedAt
	now := time.Now().UnixMilli()
	if created == nil {
		created = &now
	}
	if updated == nil {
		updated = &now
	}
	return &dbBook{
		UserID:                 uid,
		BookHash:               p.Hash,
		MetaHash:               p.MetaHash,
		Format:                 p.Format,
		Title:                  sanitize(p.Title),
		SourceTitle:            sanitize(p.SourceTitle),
		Author:                 sanitize(p.Author),
		GroupID:                p.GroupID,
		GroupName:              sanitize(p.GroupName),
		Tags:                   p.Tags,
		Progress:               p.Progress,
		ReadingStatus:          p.ReadingStatus,
		ReadingStatusUpdatedAt: epochMsToISO(p.ReadingStatusUpdatedAt),
		CoverHash:              p.CoverHash,
		CoverUpdatedAt:         epochMsToISO(p.CoverUpdatedAt),
		Metadata:               rawOrNil(p.Metadata),
		MetadataUpdatedAt:      epochMsToISO(p.MetadataUpdatedAt),
		CreatedAt:              time.UnixMilli(*created).UTC().Format(time.RFC3339),
		UpdatedAt:              time.UnixMilli(*updated).UTC().Format(time.RFC3339),
		DeletedAt:              epochMsToISO(p.DeletedAt),
		UploadedAt:             epochMsToISO(p.UploadedAt),
		PinnedAt:               epochMsToISO(p.PinnedAt),
		SyncedAt:               syncedAt,
	}
}

// pushedConfig mirrors the client BookConfig record (types/book.ts).
type pushedConfig struct {
	BookHash     string          `json:"bookHash"`
	MetaHash     string          `json:"metaHash"`
	Progress     json.RawMessage `json:"progress"`
	Location     string          `json:"location"`
	XPointer     string          `json:"xpointer"`
	RSVPPosition json.RawMessage `json:"rsvpPosition"`
	SearchConfig json.RawMessage `json:"searchConfig"`
	ViewSettings json.RawMessage `json:"viewSettings"`
	UpdatedAt    *int64          `json:"updatedAt"`
}

// dbBookConfig is the DB-shaped config record; the client parses it with
// transformBookConfigFromDB. updated_at stays an epoch-ms integer so the store
// can LWW and cursor on it (new Date(updated_at).getTime() works client-side
// for both integers and ISO strings).
type dbBookConfig struct {
	UserID       string  `json:"user_id"`
	BookHash     string  `json:"book_hash"`
	MetaHash     string  `json:"meta_hash,omitempty"`
	Progress     *string `json:"progress"`
	Location     string  `json:"location"`
	XPointer     string  `json:"xpointer"`
	RSVPPosition *string `json:"rsvp_position"`
	SearchConfig *string `json:"search_config"`
	ViewSettings *string `json:"view_settings"`
	CreatedAt    *int64  `json:"created_at"`
	UpdatedAt    *int64  `json:"updated_at"`
	DeletedAt    *int64  `json:"deleted_at"`
}

func configToDB(p *pushedConfig, uid string) *dbBookConfig {
	return &dbBookConfig{
		UserID:       uid,
		BookHash:     p.BookHash,
		MetaHash:     p.MetaHash,
		Progress:     rawOrNil(p.Progress),
		Location:     p.Location,
		XPointer:     p.XPointer,
		RSVPPosition: rawOrNil(p.RSVPPosition),
		SearchConfig: rawOrNil(p.SearchConfig),
		ViewSettings: rawOrNil(p.ViewSettings),
		CreatedAt:    p.UpdatedAt,
		UpdatedAt:    p.UpdatedAt,
	}
}

// pushedNote mirrors the client BookNote record (types/book.ts).
type pushedNote struct {
	BookHash  string `json:"bookHash"`
	MetaHash  string `json:"metaHash"`
	ID        string `json:"id"`
	Type      string `json:"type"`
	CFI       string `json:"cfi"`
	XPointer0 string `json:"xpointer0"`
	XPointer1 string `json:"xpointer1"`
	Page      *int   `json:"page"`
	Text      string `json:"text"`
	Style     string `json:"style"`
	Color     string `json:"color"`
	Note      string `json:"note"`
	Global    *bool  `json:"global"`
	CreatedAt *int64 `json:"createdAt"`
	UpdatedAt *int64 `json:"updatedAt"`
	DeletedAt *int64 `json:"deletedAt"`
}

// dbBookNote is the DB-shaped note record; the client parses it with
// transformBookNoteFromDB.
type dbBookNote struct {
	UserID    string `json:"user_id"`
	BookHash  string `json:"book_hash"`
	MetaHash  string `json:"meta_hash,omitempty"`
	ID        string `json:"id"`
	Type      string `json:"type"`
	CFI       string `json:"cfi"`
	XPointer0 string `json:"xpointer0,omitempty"`
	XPointer1 string `json:"xpointer1,omitempty"`
	Page      *int   `json:"page,omitempty"`
	Text      string `json:"text"`
	Style     string `json:"style,omitempty"`
	Color     string `json:"color,omitempty"`
	Note      string `json:"note"`
	Global    *bool  `json:"global,omitempty"`
	CreatedAt *int64 `json:"created_at"`
	UpdatedAt *int64 `json:"updated_at"`
	DeletedAt *int64 `json:"deleted_at"`
}

func noteToDB(p *pushedNote, uid string) *dbBookNote {
	return &dbBookNote{
		UserID:    uid,
		BookHash:  p.BookHash,
		MetaHash:  p.MetaHash,
		ID:        p.ID,
		Type:      p.Type,
		CFI:       p.CFI,
		XPointer0: p.XPointer0,
		XPointer1: p.XPointer1,
		Page:      p.Page,
		Text:      sanitize(p.Text),
		Style:     p.Style,
		Color:     p.Color,
		Note:      p.Note,
		Global:    p.Global,
		CreatedAt: p.CreatedAt,
		UpdatedAt: p.UpdatedAt,
		DeletedAt: p.DeletedAt,
	}
}
