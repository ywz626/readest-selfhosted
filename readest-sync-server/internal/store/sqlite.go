package store

import (
	"context"
	"database/sql"
	"time"

	_ "modernc.org/sqlite"
)

type SqliteStore struct {
	db *sql.DB
}

func NewSqliteStore(dsn string) (*SqliteStore, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// WAL + busy timeout for concurrent access.
	_, _ = db.Exec(`PRAGMA journal_mode=WAL;`)
	_, _ = db.Exec(`PRAGMA busy_timeout=5000;`)
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS books (
			id TEXT, user_id TEXT, book_hash TEXT, meta_hash TEXT,
			updated_at INTEGER, deleted_at INTEGER, synced_at TEXT, data TEXT,
			PRIMARY KEY (user_id, book_hash)
		);
		CREATE TABLE IF NOT EXISTS notes (
			user_id TEXT, note_id TEXT, updated_at INTEGER, deleted_at INTEGER, data TEXT,
			PRIMARY KEY(user_id, note_id)
		);
		CREATE TABLE IF NOT EXISTS configs (
			user_id TEXT, config_id TEXT, updated_at INTEGER, data TEXT,
			PRIMARY KEY(user_id, config_id)
		);
		CREATE TABLE IF NOT EXISTS stat_books (
			user_id TEXT, book_hash TEXT, title TEXT, authors TEXT, updated_at_ms INTEGER, deleted_at INTEGER,
			PRIMARY KEY(user_id, book_hash)
		);
		CREATE TABLE IF NOT EXISTS stat_pages (
			user_id TEXT, book_hash TEXT, page INTEGER, start_time INTEGER, duration INTEGER, total_pages INTEGER, updated_at_ms INTEGER, deleted_at INTEGER,
			PRIMARY KEY(user_id, book_hash, page)
		);
		CREATE TABLE IF NOT EXISTS replicas (
			user_id TEXT, kind TEXT, replica_id TEXT, fields_jsonb TEXT, manifest_jsonb TEXT, deleted_at_ts TEXT, reincarnation TEXT, updated_at_ts TEXT, schema_version INTEGER,
			PRIMARY KEY(user_id, kind, replica_id)
		);
		CREATE TABLE IF NOT EXISTS replica_keys (
			user_id TEXT, salt_id TEXT, alg TEXT, salt TEXT, created_at TEXT,
			PRIMARY KEY(user_id, salt_id)
		);
	`)
	if err != nil {
		return nil, err
	}
	return &SqliteStore{db: db}, nil
}

func (s *SqliteStore) UpsertBook(ctx context.Context, b BookRow) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO books (id,user_id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data)
		VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id,book_hash) DO UPDATE SET
			id=excluded.id, meta_hash=excluded.meta_hash, updated_at=excluded.updated_at,
			deleted_at=excluded.deleted_at, synced_at=excluded.synced_at, data=excluded.data`,
		b.ID, b.UserID, b.BookHash, b.MetaHash, b.UpdatedAt, b.DeletedAt, b.SyncedAt, string(b.Data))
	return err
}

func (s *SqliteStore) PullBooks(ctx context.Context, userID, sinceISO string, limit int) ([]BookRow, error) {
	since := sinceISO
	if since == "" {
		since = "0001-01-01T00:00:00Z"
	}
	if limit <= 0 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data FROM books
		WHERE user_id=? AND synced_at > ? ORDER BY synced_at ASC LIMIT ?`, userID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BookRow
	for rows.Next() {
		var b BookRow
		var data string
		if err := rows.Scan(&b.ID, &b.BookHash, &b.MetaHash, &b.UpdatedAt, &b.DeletedAt, &b.SyncedAt, &data); err != nil {
			return nil, err
		}
		b.Data = []byte(data)
		b.UserID = userID
		out = append(out, b)
	}
	// tie-completion: include all rows sharing the tail synced_at value.
	if len(out) > 0 {
		tail := out[len(out)-1].SyncedAt
		tie, err := s.db.QueryContext(ctx, `
			SELECT id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data FROM books
			WHERE user_id=? AND synced_at=?`, userID, tail)
		if err != nil {
			return nil, err
		}
		defer tie.Close()
		for tie.Next() {
			var b BookRow
			var data string
			if err := tie.Scan(&b.ID, &b.BookHash, &b.MetaHash, &b.UpdatedAt, &b.DeletedAt, &b.SyncedAt, &data); err != nil {
				return nil, err
			}
			b.Data = []byte(data)
			b.UserID = userID
			dup := false
			for _, e := range out {
				if e.BookHash == b.BookHash {
					dup = true
					break
				}
			}
			if !dup {
				out = append(out, b)
			}
		}
	}
	return out, nil
}

func (s *SqliteStore) UpsertNote(ctx context.Context, userID string, data []byte) error {
	var noteID string
	var updatedAt *int64
	if err := jsonUnmarshalField(data, "id", &noteID); err != nil {
		return err
	}
	if err := jsonUnmarshalField(data, "updated_at", &updatedAt); err != nil {
		return err
	}
	// last-writer-wins by updated_at
	existing, _ := s.db.QueryContext(ctx, `SELECT updated_at FROM notes WHERE user_id=? AND note_id=?`, userID, noteID)
	var old *int64
	if existing != nil {
		defer existing.Close()
		if existing.Next() {
			var v sql.NullInt64
			if existing.Scan(&v) == nil && v.Valid {
				vv := v.Int64
				old = &vv
			}
		}
	}
	if old != nil && updatedAt != nil && *updatedAt < *old {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO notes (user_id,note_id,updated_at,deleted_at,data)
		VALUES (?,?,?,?,?)
		ON CONFLICT(user_id,note_id) DO UPDATE SET updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, data=excluded.data`,
		userID, noteID, updatedAt, nil, string(data))
	return err
}

func (s *SqliteStore) PullNotes(ctx context.Context, userID string, sinceMs int64) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT data FROM notes WHERE user_id=? AND COALESCE(updated_at,0) > ? ORDER BY updated_at ASC`, userID, sinceMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		out = append(out, []byte(data))
	}
	return out, nil
}

func (s *SqliteStore) UpsertConfig(ctx context.Context, userID string, data []byte) error {
	var configID string
	var updatedAt *int64
	if err := jsonUnmarshalField(data, "id", &configID); err != nil {
		return err
	}
	if err := jsonUnmarshalField(data, "updated_at", &updatedAt); err != nil {
		return err
	}
	existing, _ := s.db.QueryContext(ctx, `SELECT updated_at FROM configs WHERE user_id=? AND config_id=?`, userID, configID)
	var old *int64
	if existing != nil {
		defer existing.Close()
		if existing.Next() {
			var v sql.NullInt64
			if existing.Scan(&v) == nil && v.Valid {
				vv := v.Int64
				old = &vv
			}
		}
	}
	if old != nil && updatedAt != nil && *updatedAt < *old {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO configs (user_id,config_id,updated_at,data)
		VALUES (?,?,?,?)
		ON CONFLICT(user_id,config_id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data`,
		userID, configID, updatedAt, string(data))
	return err
}

func (s *SqliteStore) PullConfigs(ctx context.Context, userID string, sinceMs int64) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT data FROM configs WHERE user_id=? AND COALESCE(updated_at,0) > ? ORDER BY updated_at ASC`, userID, sinceMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		out = append(out, []byte(data))
	}
	return out, nil
}

func (s *SqliteStore) UpsertStatBooks(ctx context.Context, rows []StatBookRow) error {
	for _, r := range rows {
		_, err := s.db.ExecContext(ctx, `
			INSERT INTO stat_books (user_id,book_hash,title,authors,updated_at_ms,deleted_at)
			VALUES (?,?,?,?,?,?)
			ON CONFLICT(user_id,book_hash) DO UPDATE SET
				title=excluded.title, authors=excluded.authors, updated_at_ms=excluded.updated_at_ms, deleted_at=excluded.deleted_at`,
			r.UserID, r.BookHash, r.Title, r.Authors, r.UpdatedAtMs, r.DeletedAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *SqliteStore) PullStatBooks(ctx context.Context, userID string, sinceMs int64) ([]StatBookRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT book_hash,title,authors,updated_at_ms,deleted_at FROM stat_books
		WHERE user_id=? AND COALESCE(updated_at_ms,0) > ? ORDER BY updated_at_ms ASC`, userID, sinceMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StatBookRow
	for rows.Next() {
		var r StatBookRow
		if err := rows.Scan(&r.BookHash, &r.Title, &r.Authors, &r.UpdatedAtMs, &r.DeletedAt); err != nil {
			return nil, err
		}
		r.UserID = userID
		out = append(out, r)
	}
	return out, nil
}

func (s *SqliteStore) UpsertStatPages(ctx context.Context, rows []StatPageRow) error {
	for _, r := range rows {
		_, err := s.db.ExecContext(ctx, `
			INSERT INTO stat_pages (user_id,book_hash,page,start_time,duration,total_pages,updated_at_ms,deleted_at)
			VALUES (?,?,?,?,?,?,?,?)
			ON CONFLICT(user_id,book_hash,page) DO UPDATE SET
				start_time=excluded.start_time, duration=excluded.duration, total_pages=excluded.total_pages,
				updated_at_ms=excluded.updated_at_ms, deleted_at=excluded.deleted_at`,
			r.UserID, r.BookHash, r.Page, r.StartTime, r.Duration, r.TotalPages, r.UpdatedAtMs, r.DeletedAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *SqliteStore) PullStatPages(ctx context.Context, userID string, sinceMs int64) ([]StatPageRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT book_hash,page,start_time,duration,total_pages,updated_at_ms,deleted_at FROM stat_pages
		WHERE user_id=? AND COALESCE(updated_at_ms,0) > ? ORDER BY updated_at_ms ASC`, userID, sinceMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StatPageRow
	for rows.Next() {
		var r StatPageRow
		if err := rows.Scan(&r.BookHash, &r.Page, &r.StartTime, &r.Duration, &r.TotalPages, &r.UpdatedAtMs, &r.DeletedAt); err != nil {
			return nil, err
		}
		r.UserID = userID
		out = append(out, r)
	}
	return out, nil
}

// hlcMax returns the lexicographically greater HLC (client HLC format guarantees
// lexicographic order == time order).
func hlcMax(a, b string) string {
	if a > b {
		return a
	}
	return b
}

func (s *SqliteStore) UpsertReplica(ctx context.Context, r ReplicaRow) error {
	// last-writer-wins by updated_at_ts (HLC string compare)
	var oldTS sql.NullString
	_ = s.db.QueryRowContext(ctx,
		`SELECT updated_at_ts FROM replicas WHERE user_id=? AND kind=? AND replica_id=?`,
		r.UserID, r.Kind, r.ReplicaID).Scan(&oldTS)
	if oldTS.Valid && r.UpdatedAtTS < oldTS.String {
		// incoming is older; ignore.
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO replicas (user_id,kind,replica_id,fields_jsonb,manifest_jsonb,deleted_at_ts,reincarnation,updated_at_ts,schema_version)
		VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id,kind,replica_id) DO UPDATE SET
			fields_jsonb=excluded.fields_jsonb, manifest_jsonb=excluded.manifest_jsonb,
			deleted_at_ts=excluded.deleted_at_ts, reincarnation=excluded.reincarnation,
			updated_at_ts=excluded.updated_at_ts, schema_version=excluded.schema_version`,
		r.UserID, r.Kind, r.ReplicaID, string(r.FieldsJSONB), nullableString(r.ManifestJSONB),
		r.DeletedAtTS, r.Reincarnation, r.UpdatedAtTS, r.SchemaVersion)
	return err
}

func (s *SqliteStore) PullReplicas(ctx context.Context, userID, kind string, sinceHlc *string) ([]ReplicaRow, error) {
	since := ""
	if sinceHlc != nil {
		since = *sinceHlc
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT replica_id,fields_jsonb,manifest_jsonb,deleted_at_ts,reincarnation,updated_at_ts,schema_version
		FROM replicas WHERE user_id=? AND kind=? AND updated_at_ts > ? ORDER BY updated_at_ts ASC`,
		userID, kind, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReplicaRow
	for rows.Next() {
		var r ReplicaRow
		var fields, manifest, updatedAtTS string
		var deletedAtTS, reinc sql.NullString
		if err := rows.Scan(&r.ReplicaID, &fields, &manifest, &deletedAtTS, &reinc, &updatedAtTS, &r.SchemaVersion); err != nil {
			return nil, err
		}
		r.FieldsJSONB = []byte(fields)
		if manifest != "" {
			r.ManifestJSONB = []byte(manifest)
		}
		if deletedAtTS.Valid {
			v := deletedAtTS.String
			r.DeletedAtTS = &v
		}
		if reinc.Valid {
			v := reinc.String
			r.Reincarnation = &v
		}
		r.UpdatedAtTS = updatedAtTS
		r.UserID = userID
		r.Kind = kind
		out = append(out, r)
	}
	return out, nil
}

func (s *SqliteStore) PullReplicasBatch(ctx context.Context, userID string, cursors []ReplicaCursor) (map[string][]ReplicaRow, error) {
	out := make(map[string][]ReplicaRow)
	for _, c := range cursors {
		rows, err := s.PullReplicas(ctx, userID, c.Kind, c.Since)
		if err != nil {
			return nil, err
		}
		out[c.Kind] = rows
	}
	return out, nil
}

func (s *SqliteStore) UpsertReplicaKey(ctx context.Context, userID, alg, saltID, salt string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO replica_keys (user_id,salt_id,alg,salt,created_at)
		VALUES (?,?,?,?,?)
		ON CONFLICT(user_id,salt_id) DO UPDATE SET alg=excluded.alg, salt=excluded.salt, created_at=excluded.created_at`,
		userID, saltID, alg, salt, time.Now().UTC().Format(time.RFC3339))
	return err
}

func (s *SqliteStore) ListReplicaKeys(ctx context.Context, userID string) ([]ReplicaKeyRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT salt_id,alg,salt,created_at FROM replica_keys WHERE user_id=? ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReplicaKeyRow
	for rows.Next() {
		var r ReplicaKeyRow
		if err := rows.Scan(&r.SaltID, &r.Alg, &r.Salt, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func (s *SqliteStore) DeleteReplicaKeys(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM replica_keys WHERE user_id=?`, userID)
	return err
}
