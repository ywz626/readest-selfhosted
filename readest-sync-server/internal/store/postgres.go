package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

type PostgresStore struct {
	db *sql.DB
}

func NewPostgresStore(dsn string) (*PostgresStore, error) {
	pgxCfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	db := stdlib.OpenDB(*pgxCfg)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	s := &PostgresStore{db: db}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *PostgresStore) migrate() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS books (
			id TEXT, user_id TEXT, book_hash TEXT, meta_hash TEXT,
			updated_at BIGINT, deleted_at BIGINT, synced_at TEXT, data TEXT,
			PRIMARY KEY (user_id, book_hash)
		);
		CREATE TABLE IF NOT EXISTS notes (
			user_id TEXT, note_id TEXT, updated_at BIGINT, deleted_at BIGINT, data TEXT,
			PRIMARY KEY(user_id, note_id)
		);
		CREATE TABLE IF NOT EXISTS configs (
			user_id TEXT, config_id TEXT, updated_at BIGINT, data TEXT,
			PRIMARY KEY(user_id, config_id)
		);
		CREATE TABLE IF NOT EXISTS stat_books (
			user_id TEXT, book_hash TEXT, title TEXT, authors TEXT, updated_at_ms BIGINT, deleted_at BIGINT,
			PRIMARY KEY(user_id, book_hash)
		);
		CREATE TABLE IF NOT EXISTS stat_pages (
			user_id TEXT, book_hash TEXT, page INTEGER, start_time BIGINT, duration BIGINT, total_pages INTEGER, updated_at_ms BIGINT, deleted_at BIGINT,
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
	return err
}

func (s *PostgresStore) UpsertBook(ctx context.Context, b BookRow) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO books (id,user_id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT(user_id,book_hash) DO UPDATE SET
			id=EXCLUDED.id, meta_hash=EXCLUDED.meta_hash, updated_at=EXCLUDED.updated_at,
			deleted_at=EXCLUDED.deleted_at, synced_at=EXCLUDED.synced_at, data=EXCLUDED.data`,
		b.ID, b.UserID, b.BookHash, b.MetaHash, b.UpdatedAt, b.DeletedAt, b.SyncedAt, string(b.Data))
	return err
}

func (s *PostgresStore) PullBooks(ctx context.Context, userID, sinceISO string, limit int) ([]BookRow, error) {
	since := sinceISO
	if since == "" {
		since = "0001-01-01T00:00:00Z"
	}
	if limit <= 0 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data FROM books
		WHERE user_id=$1 AND synced_at > $2 ORDER BY synced_at ASC LIMIT $3`, userID, since, limit)
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
	if len(out) > 0 {
		tail := out[len(out)-1].SyncedAt
		tie, err := s.db.QueryContext(ctx, `
			SELECT id,book_hash,meta_hash,updated_at,deleted_at,synced_at,data FROM books
			WHERE user_id=$1 AND synced_at=$2`, userID, tail)
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

func (s *PostgresStore) UpsertNote(ctx context.Context, userID string, data []byte) error {
	var noteID string
	var updatedAt *int64
	var deletedAt *int64
	_ = jsonUnmarshalField(data, "id", &noteID)
	_ = jsonUnmarshalField(data, "updated_at", &updatedAt)
	_ = jsonUnmarshalField(data, "deleted_at", &deletedAt)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO notes (user_id,note_id,updated_at,deleted_at,data)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT(user_id,note_id) DO UPDATE SET updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at, data=EXCLUDED.data`,
		userID, noteID, updatedAt, deletedAt, string(data))
	return err
}

func (s *PostgresStore) PullNotes(ctx context.Context, userID string, sinceMs int64) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT data FROM notes WHERE user_id=$1 AND COALESCE(updated_at,0) > $2 ORDER BY updated_at ASC`, userID, sinceMs)
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

func (s *PostgresStore) UpsertConfig(ctx context.Context, userID string, data []byte) error {
	// One config row per book, keyed by book_hash.
	var configID string
	var updatedAt *int64
	_ = jsonUnmarshalField(data, "book_hash", &configID)
	_ = jsonUnmarshalField(data, "updated_at", &updatedAt)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO configs (user_id,config_id,updated_at,data)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT(user_id,config_id) DO UPDATE SET updated_at=EXCLUDED.updated_at, data=EXCLUDED.data`,
		userID, configID, updatedAt, string(data))
	return err
}

func (s *PostgresStore) PullConfigs(ctx context.Context, userID string, sinceMs int64) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT data FROM configs WHERE user_id=$1 AND COALESCE(updated_at,0) > $2 ORDER BY updated_at ASC`, userID, sinceMs)
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

func (s *PostgresStore) UpsertStatBooks(ctx context.Context, rows []StatBookRow) error {
	for _, r := range rows {
		_, err := s.db.ExecContext(ctx, `
			INSERT INTO stat_books (user_id,book_hash,title,authors,updated_at_ms,deleted_at)
			VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT(user_id,book_hash) DO UPDATE SET
				title=EXCLUDED.title, authors=EXCLUDED.authors, updated_at_ms=EXCLUDED.updated_at_ms, deleted_at=EXCLUDED.deleted_at`,
			r.UserID, r.BookHash, r.Title, r.Authors, r.UpdatedAtMs, r.DeletedAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *PostgresStore) PullStatBooks(ctx context.Context, userID string, sinceMs int64) ([]StatBookRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT book_hash,title,authors,updated_at_ms,deleted_at FROM stat_books
		WHERE user_id=$1 AND COALESCE(updated_at_ms,0) > $2 ORDER BY updated_at_ms ASC`, userID, sinceMs)
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

func (s *PostgresStore) UpsertStatPages(ctx context.Context, rows []StatPageRow) error {
	for _, r := range rows {
		_, err := s.db.ExecContext(ctx, `
			INSERT INTO stat_pages (user_id,book_hash,page,start_time,duration,total_pages,updated_at_ms,deleted_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT(user_id,book_hash,page) DO UPDATE SET
				start_time=EXCLUDED.start_time, duration=EXCLUDED.duration, total_pages=EXCLUDED.total_pages,
				updated_at_ms=EXCLUDED.updated_at_ms, deleted_at=EXCLUDED.deleted_at`,
			r.UserID, r.BookHash, r.Page, r.StartTime, r.Duration, r.TotalPages, r.UpdatedAtMs, r.DeletedAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *PostgresStore) PullStatPages(ctx context.Context, userID string, sinceMs int64) ([]StatPageRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT book_hash,page,start_time,duration,total_pages,updated_at_ms,deleted_at FROM stat_pages
		WHERE user_id=$1 AND COALESCE(updated_at_ms,0) > $2 ORDER BY updated_at_ms ASC`, userID, sinceMs)
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

func (s *PostgresStore) UpsertReplica(ctx context.Context, r ReplicaRow) error {
	var oldTS sql.NullString
	_ = s.db.QueryRowContext(ctx,
		`SELECT updated_at_ts FROM replicas WHERE user_id=$1 AND kind=$2 AND replica_id=$3`,
		r.UserID, r.Kind, r.ReplicaID).Scan(&oldTS)
	if oldTS.Valid && r.UpdatedAtTS < oldTS.String {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO replicas (user_id,kind,replica_id,fields_jsonb,manifest_jsonb,deleted_at_ts,reincarnation,updated_at_ts,schema_version)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT(user_id,kind,replica_id) DO UPDATE SET
			fields_jsonb=EXCLUDED.fields_jsonb, manifest_jsonb=EXCLUDED.manifest_jsonb,
			deleted_at_ts=EXCLUDED.deleted_at_ts, reincarnation=EXCLUDED.reincarnation,
			updated_at_ts=EXCLUDED.updated_at_ts, schema_version=EXCLUDED.schema_version`,
		r.UserID, r.Kind, r.ReplicaID, string(r.FieldsJSONB), nullableString(r.ManifestJSONB),
		r.DeletedAtTS, r.Reincarnation, r.UpdatedAtTS, r.SchemaVersion)
	return err
}

func (s *PostgresStore) PullReplicas(ctx context.Context, userID, kind string, sinceHlc *string) ([]ReplicaRow, error) {
	since := ""
	if sinceHlc != nil {
		since = *sinceHlc
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT replica_id,fields_jsonb,manifest_jsonb,deleted_at_ts,reincarnation,updated_at_ts,schema_version
		FROM replicas WHERE user_id=$1 AND kind=$2 AND updated_at_ts > $3 ORDER BY updated_at_ts ASC`,
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

func (s *PostgresStore) PullReplicasBatch(ctx context.Context, userID string, cursors []ReplicaCursor) (map[string][]ReplicaRow, error) {
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

func (s *PostgresStore) UpsertReplicaKey(ctx context.Context, userID, alg, saltID, salt string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO replica_keys (user_id,salt_id,alg,salt,created_at)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT(user_id,salt_id) DO UPDATE SET alg=EXCLUDED.alg, salt=EXCLUDED.salt, created_at=EXCLUDED.created_at`,
		userID, saltID, alg, salt, time.Now().UTC().Format(time.RFC3339))
	return err
}

func (s *PostgresStore) ListReplicaKeys(ctx context.Context, userID string) ([]ReplicaKeyRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT salt_id,alg,salt,created_at FROM replica_keys WHERE user_id=$1 ORDER BY created_at ASC`, userID)
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

func (s *PostgresStore) DeleteReplicaKeys(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM replica_keys WHERE user_id=$1`, userID)
	return err
}
