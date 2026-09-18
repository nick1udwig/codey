// Package collectionstore owns transactional, durable collection data.
package collectionstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	c "github.com/nick1udwig/pebble-agent/internal/collections"
	_ "modernc.org/sqlite"
)

type Store struct {
	DB        *sql.DB
	mu        sync.Mutex
	ServerID  string
	Epoch     string
	cursorKey string
	Fault     func(string) error
}

const schema = `
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,principal TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,principal TEXT NOT NULL,data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL REFERENCES collections(id),data BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS records_collection_state ON records(collection_id,json_extract(data,'$.deleted'),json_extract(data,'$.completed'),json_extract(data,'$.end'));
CREATE TABLE IF NOT EXISTS versions(record_id TEXT NOT NULL,revision TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(record_id,revision));
CREATE TABLE IF NOT EXISTS version_bodies(record_id TEXT NOT NULL,revision TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(record_id,revision),FOREIGN KEY(record_id,revision) REFERENCES versions(record_id,revision) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS body_chunks(record_id TEXT NOT NULL,revision TEXT NOT NULL,position INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(record_id,revision,position),FOREIGN KEY(record_id,revision) REFERENCES version_bodies(record_id,revision) ON DELETE CASCADE) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),ingress TEXT UNIQUE NOT NULL,data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,collection_id TEXT NOT NULL,data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY,data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,epoch TEXT NOT NULL,expires INTEGER NOT NULL,cursor TEXT NOT NULL,total INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_expiry ON snapshots(expires);
CREATE TABLE IF NOT EXISTS snapshot_records(snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,position INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(snapshot_id,position)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS record_summaries(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,data BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS summaries_collection ON record_summaries(collection_id,id);
CREATE TRIGGER IF NOT EXISTS summary_insert AFTER INSERT ON records BEGIN
 INSERT OR REPLACE INTO record_summaries VALUES(NEW.id,NEW.collection_id,json_remove(NEW.data,'$.body','$.description','$.extensions'));
END;
CREATE TRIGGER IF NOT EXISTS summary_update AFTER UPDATE ON records BEGIN
 DELETE FROM record_summaries WHERE id=OLD.id;
 INSERT INTO record_summaries VALUES(NEW.id,NEW.collection_id,json_remove(NEW.data,'$.body','$.description','$.extensions'));
END;
CREATE TRIGGER IF NOT EXISTS summary_delete AFTER DELETE ON records BEGIN
 DELETE FROM record_summaries WHERE id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS provider_jobs(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,record_id TEXT NOT NULL,revision TEXT NOT NULL,state TEXT NOT NULL,data BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS provider_jobs_state ON provider_jobs(state);
CREATE INDEX IF NOT EXISTS provider_jobs_unfinished_binding ON provider_jobs(binding_id) WHERE state NOT IN ('applied','stopped');
CREATE INDEX IF NOT EXISTS provider_jobs_unfinished_record ON provider_jobs(binding_id,record_id) WHERE state NOT IN ('applied','stopped');
CREATE TABLE IF NOT EXISTS mappings(binding_id TEXT NOT NULL,remote_id TEXT NOT NULL,record_id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(binding_id,remote_id));
CREATE INDEX IF NOT EXISTS mappings_record ON mappings(binding_id,record_id);
CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,data BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS changes_collection ON changes(collection_id,sequence);
PRAGMA user_version=3;
`

func Open(dir string) (*Store, error) {
	if !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("collection data directory must be absolute")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "collections.db")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	f.Close()
	if err = os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db}
	fail := func(e error) (*Store, error) { db.Close(); return nil, e }
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`); err != nil {
		return fail(err)
	}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fail(err)
	}
	if version > 3 {
		return fail(fmt.Errorf("unsupported collection schema %d", version))
	}
	if err = s.initializeSchema(version); err != nil {
		return fail(err)
	}
	for _, k := range []string{"server_instance_id", "store_epoch", "cursor_key"} {
		if _, err = db.Exec("INSERT OR IGNORE INTO metadata VALUES(?,?)", k, c.ID("")); err != nil {
			return fail(err)
		}
	}
	if err = db.QueryRow("SELECT value FROM metadata WHERE key='server_instance_id'").Scan(&s.ServerID); err != nil {
		return fail(err)
	}
	if err = db.QueryRow("SELECT value FROM metadata WHERE key='store_epoch'").Scan(&s.Epoch); err != nil {
		return fail(err)
	}
	if err = db.QueryRow("SELECT value FROM metadata WHERE key='cursor_key'").Scan(&s.cursorKey); err != nil {
		return fail(err)
	}
	for _, kind := range []string{"task", "note", "event"} {
		v := c.Collection{ID: "col_" + kind, Kind: kind, Name: map[string]string{"task": "To-dos", "note": "Notes", "event": "Calendar"}[kind], Generation: "1"}
		if _, err = db.Exec("INSERT OR IGNORE INTO collections VALUES(?,?,?)", v.ID, c.Principal, encode(v)); err != nil {
			return fail(err)
		}
	}
	return s, nil
}

// Upgrade atomically, preserving issued snapshot IDs, cursors and pinned records.
func (s *Store) initializeSchema(version int) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if version == 1 {
		if _, err = tx.Exec("ALTER TABLE snapshots RENAME TO legacy_snapshots"); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(schema); err != nil {
		return err
	}
	if version < 2 {
		if _, err = tx.Exec("INSERT OR REPLACE INTO record_summaries SELECT id,collection_id,json_remove(data,'$.body','$.description','$.extensions') FROM records"); err != nil {
			return err
		}
	}
	if version == 1 {
		if _, err = tx.Exec(`INSERT INTO snapshots SELECT id,epoch,expires,cursor,json_array_length(data) FROM legacy_snapshots;
   INSERT INTO snapshot_records SELECT s.id,CAST(j.key AS INTEGER),j.value FROM legacy_snapshots s,json_each(s.data) j;
   DROP TABLE legacy_snapshots;`); err != nil {
			return err
		}
	}
	if version < 3 {
		if err = migrateVersionBodies(tx); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) Close() error { return s.DB.Close() }
func encode(v any) []byte {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return b
}
func Decode[T any](b []byte) (T, error) { var v T; e := json.Unmarshal(b, &v); return v, e }
func (s *Store) hit(name string) error {
	if s.Fault != nil {
		return s.Fault(name)
	}
	return nil
}
func (s *Store) Enroll() (string, error) {
	id := c.ID("client_")
	_, e := s.DB.Exec("INSERT INTO clients(id,principal) VALUES(?,?)", id, c.Principal)
	return id, e
}
func (s *Store) Collections() ([]c.Collection, error) { return s.CollectionsInZone(0) }
func (s *Store) CollectionsInZone(offset int) ([]c.Collection, error) {
	if offset < -840 || offset > 840 {
		return nil, c.Fail("invalid_input", "Invalid timezone offset")
	}
	loc := time.FixedZone("phone", offset*60)
	rows, e := s.DB.Query("SELECT data FROM collections WHERE principal=? ORDER BY id", c.Principal)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []c.Collection{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			return nil, e
		}
		v, e := Decode[c.Collection](b)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	rows.Close()
	now := time.Now().In(loc)
	for i := range out {
		col := &out[i]
		const activeRows = " FROM records WHERE collection_id=? AND json_extract(data,'$.deleted')=0"
		if col.Kind != "event" {
			query := "SELECT count(*)" + activeRows
			if col.Kind == "task" {
				query += " AND json_extract(data,'$.completed')=0"
			}
			if e = s.DB.QueryRow(query, col.ID).Scan(&col.Count); e != nil {
				return nil, e
			}
			continue
		}
		// The covering index supplies dates without reading or decoding event bodies.
		dates, err := s.DB.Query("SELECT json_extract(data,'$.end')"+activeRows, col.ID)
		if err != nil {
			return nil, err
		}
		for dates.Next() {
			var end sql.NullString
			if err = dates.Scan(&end); err != nil {
				dates.Close()
				return nil, err
			}
			if c.Visible(c.Record{Kind: "event", End: end.String}, "active", now) {
				col.Count++
			}
		}
		err = dates.Err()
		dates.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
func (s *Store) Record(id, revision string) (c.Record, error) {
	var b []byte
	var e error
	if revision == "" {
		e = s.DB.QueryRow("SELECT data FROM records WHERE id=?", id).Scan(&b)
	} else {
		e = s.DB.QueryRow("SELECT data FROM versions WHERE record_id=? AND revision=?", id, revision).Scan(&b)
	}
	if errors.Is(e, sql.ErrNoRows) {
		return c.Record{}, c.Fail("not_found", "Record or revision unavailable")
	}
	if e != nil {
		return c.Record{}, e
	}
	record, err := Decode[c.Record](b)
	if err != nil || revision == "" {
		return record, err
	}
	var length int64
	if err = s.DB.QueryRow("SELECT bytes FROM version_bodies WHERE record_id=? AND revision=?", id, revision).Scan(&length); err != nil {
		return record, err
	}
	record.Body, err = s.bodyRange(id, revision, 0, length)
	return record, err
}
func (s *Store) Receipt(id string, ingress bool) (c.Receipt, error) {
	column := "id"
	if ingress {
		column = "ingress"
	}
	var b []byte
	e := s.DB.QueryRow("SELECT data FROM operations WHERE "+column+"=?", id).Scan(&b)
	if errors.Is(e, sql.ErrNoRows) {
		return c.Receipt{}, c.Fail("not_found", "Operation not recorded")
	}
	if e != nil {
		return c.Receipt{}, e
	}
	return Decode[c.Receipt](b)
}
func (s *Store) Mutate(batch c.Batch) ([]c.Result, error) {
	if batch.Version != c.ProtocolVersion {
		return nil, c.Fail("invalid_input", "Unsupported collection protocol")
	}
	if batch.ServerID != s.ServerID {
		return nil, c.Fail("server_mismatch", "Server identity changed")
	}
	if batch.Epoch != s.Epoch {
		return nil, c.Fail("store_epoch_changed", "Store restored; recovery required")
	}
	var owner string
	if e := s.DB.QueryRow("SELECT principal FROM clients WHERE id=? AND revoked=0", batch.ClientID).Scan(&owner); e != nil || owner != c.Principal {
		return nil, c.Fail("permission_denied", "Client is not enrolled")
	}
	if len(batch.Operations) == 0 || len(batch.Operations) > 20 {
		return nil, c.Fail("invalid_input", "Batch requires 1–20 operations")
	}
	results := []c.Result{}
	for _, op := range batch.Operations {
		if e := c.ValidateIdentity(batch.ClientID, op); e != nil {
			return nil, e
		}
		r, e := s.mutate(batch.ClientID, op)
		if e != nil {
			return nil, e
		}
		results = append(results, r)
	}
	return results, nil
}
func (s *Store) mutate(client string, op c.Operation) (result c.Result, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.DB.Begin()
	if e != nil {
		return result, e
	}
	defer tx.Rollback()
	var b []byte
	e = tx.QueryRow("SELECT data FROM operations WHERE id=? OR ingress=?", op.ID, op.IngressID).Scan(&b)
	if e == nil {
		receipt, e := Decode[c.Receipt](b)
		if e != nil {
			return result, e
		}
		if receipt.Hash != c.Hash(op) {
			return result, c.Fail("idempotency_mismatch", "Operation identity was reused with different input")
		}
		receipt.Result.Duplicate = true
		return receipt.Result, nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return result, e
	}
	wire := op
	result = c.Result{OperationID: op.ID, RecordID: op.RecordID}
	for _, id := range append(append([]string{}, op.DependsOn...), op.BaseOperationID) {
		if id == "" {
			continue
		}
		if e = tx.QueryRow("SELECT data FROM operations WHERE id=? AND client_id=?", id, client).Scan(&b); e != nil {
			if !errors.Is(e, sql.ErrNoRows) {
				return result, e
			}
			result.Outcome = "blocked_dependency"
			return result, nil
		}
		parent, e := Decode[c.Receipt](b)
		if e != nil {
			return result, e
		}
		if parent.Result.Outcome != "applied" {
			result.Outcome = "blocked_dependency"
			return result, nil
		}
		if id == op.BaseOperationID {
			if parent.Result.RecordID != op.RecordID {
				return result, c.Fail("invalid_input", "Base operation targets another record")
			}
			op.BaseRevision = parent.Result.Revision
		}
	}
	// Hash the wire request, not the resolved base revision.

	if e = tx.QueryRow("SELECT data FROM collections WHERE id=? AND principal=?", op.CollectionID, c.Principal).Scan(&b); e != nil {
		return result, c.Fail("permission_denied", "Unknown collection")
	}
	col, e := Decode[c.Collection](b)
	if e != nil {
		return result, e
	}
	if op.Generation != col.Generation {
		return result, c.Fail("binding_changed", "Collection destination changed; recover pending input")
	}
	var old *c.Record
	e = tx.QueryRow("SELECT data FROM records WHERE id=? AND collection_id=?", op.RecordID, col.ID).Scan(&b)
	if e == nil {
		v, er := Decode[c.Record](b)
		if er != nil {
			return result, er
		}
		old = &v
	} else if !errors.Is(e, sql.ErrNoRows) {
		return result, e
	}
	if op.Type == "conflict.resolve" {
		var conflictID, decision string
		if json.Unmarshal(op.Payload["conflict_id"], &conflictID) != nil || json.Unmarshal(op.Payload["decision"], &decision) != nil || (decision != "keep" && decision != "proposal") {
			return result, c.Fail("invalid_input", "Conflict resolution requires conflict_id and decision")
		}
		var raw []byte
		if e = tx.QueryRow("SELECT data FROM conflicts WHERE id=?", conflictID).Scan(&raw); e != nil {
			return result, c.Fail("not_found", "Conflict unavailable")
		}
		conf, er := Decode[c.Conflict](raw)
		if er != nil {
			return result, er
		}
		if conf.Operation.CollectionID != op.CollectionID || conf.Operation.RecordID != op.RecordID {
			return result, c.Fail("permission_denied", "Conflict targets another record")
		}
		if e = resolveConflict(tx, conflictID, op.BaseRevision, decision == "proposal"); e != nil {
			return result, e
		}
		result.Outcome = "applied"
		result.Durable = true
		if e = tx.QueryRow("SELECT data FROM records WHERE id=?", op.RecordID).Scan(&raw); e == nil {
			r, er := Decode[c.Record](raw)
			if er != nil {
				return result, er
			}
			summary := r.Summary()
			result.Record = &summary
			result.Revision = r.Revision
		}
		receipt := c.Receipt{ClientID: client, Request: wire, Hash: c.Hash(wire), Result: result}
		if _, e = tx.Exec("INSERT INTO operations VALUES(?,?,?,?)", op.ID, client, op.IngressID, encode(receipt)); e != nil {
			return result, e
		}
		if e = s.hit("mutation.before_commit"); e != nil {
			return result, e
		}
		if e = tx.Commit(); e != nil {
			return result, e
		}
		return result, s.hit("mutation.after_commit")
	}
	var next c.Record
	if old != nil && op.Type != "task.create" && op.Type != "note.create" && op.BaseRevision != old.Revision {
		e = c.Fail("stale_revision", "Record changed since displayed revision")
	} else {
		next, e = c.Apply(old, op, col.Kind)
	}
	if e != nil {
		code := "invalid_input"
		var ce *c.Error
		if errors.As(e, &ce) {
			code = ce.Code
		}
		conflict := c.Conflict{ID: c.ID("conflict_"), Operation: wire, Current: old, Cause: code}
		if _, e = tx.Exec("INSERT INTO conflicts VALUES(?,?)", conflict.ID, encode(conflict)); e != nil {
			return result, e
		}
		result.Outcome = "conflict"
		result.ConflictID = conflict.ID
		result.Code = code
	} else {
		if col.BindingID != "" {
			next.ProviderState = "pending"
		}
		if _, e = tx.Exec("INSERT INTO records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", next.ID, col.ID, encode(next)); e != nil {
			return result, e
		}
		if e = writeVersion(tx, next); e != nil {
			return result, e
		}
		change, e := tx.Exec("INSERT INTO changes(collection_id,data) VALUES(?,?)", col.ID, encode(next.Summary()))
		if e != nil {
			return result, e
		}
		seq, e := change.LastInsertId()
		if e != nil {
			return result, e
		}
		result.Outcome = "applied"
		result.Revision = next.Revision
		result.Sequence = fmt.Sprint(seq)
		result.ProviderState = next.ProviderState
		summary := next.Summary()
		result.Record = &summary
		if col.BindingID != "" {
			intent := map[string]any{"operation": wire, "record": next, "base": old, "attempts": 0}
			if _, e = tx.Exec("INSERT INTO provider_jobs VALUES(?,?,?,?,?,?)", c.ID("push_"), col.BindingID, next.ID, next.Revision, "pending", encode(intent)); e != nil {
				return result, e
			}
		}
	}
	result.Durable = true
	receipt := c.Receipt{ClientID: client, Request: wire, Hash: c.Hash(wire), Result: result}
	if _, e = tx.Exec("INSERT INTO operations VALUES(?,?,?,?)", op.ID, client, op.IngressID, encode(receipt)); e != nil {
		return result, e
	}
	if e = s.hit("mutation.before_commit"); e != nil {
		return result, e
	}
	if e = tx.Commit(); e != nil {
		return result, e
	}
	if e = s.hit("mutation.after_commit"); e != nil {
		return result, e
	}
	return result, nil
}
