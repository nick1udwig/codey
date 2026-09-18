package state

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type diskState struct {
	Version  int               `json:"version"`
	Sessions map[string]string `json:"sessions"`
}
type Store struct{ db *sql.DB }

// Open imports the legacy JSON once into path + ".db". Keeping the original
// snapshot untouched makes migration recoverable; SQLite is authoritative after
// migration, including deletions. Historical conversations are never pruned.
func Open(path string) (*Store, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("state path must be absolute: %q", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path+".db", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = file.Chmod(0600); err != nil {
		file.Close()
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+".db")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var pending *sql.Tx
	fail := func(err error) (*Store, error) {
		if pending != nil {
			pending.Rollback()
		}
		db.Close()
		return nil, err
	}
	if _, err = db.Exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"); err != nil {
		return fail(err)
	}
	tx, err := db.Begin()
	if err != nil {
		return fail(err)
	}
	pending = tx
	defer tx.Rollback()
	if _, err = tx.Exec("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sessions(session TEXT PRIMARY KEY,thread TEXT NOT NULL) WITHOUT ROWID;"); err != nil {
		return fail(err)
	}
	var version int
	err = tx.QueryRow("SELECT value FROM metadata WHERE key='version'").Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		payload, readErr := os.ReadFile(path)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return fail(fmt.Errorf("read state: %w", readErr))
		}
		if readErr == nil {
			var legacy diskState
			if err = json.Unmarshal(payload, &legacy); err != nil {
				return fail(fmt.Errorf("decode state: %w", err))
			}
			if legacy.Version != 1 {
				return fail(fmt.Errorf("unsupported state version %d", legacy.Version))
			}
			stmt, err := tx.Prepare("INSERT INTO sessions VALUES(?,?)")
			if err != nil {
				return fail(err)
			}
			for session, thread := range legacy.Sessions {
				if _, err = stmt.Exec(session, thread); err != nil {
					stmt.Close()
					return fail(err)
				}
			}
			stmt.Close()
		}
		if _, err = tx.Exec("INSERT INTO metadata VALUES('version',1)"); err != nil {
			return fail(err)
		}
	} else if err != nil {
		return fail(err)
	} else if version != 1 {
		return fail(fmt.Errorf("unsupported session database version %d", version))
	}
	if err = tx.Commit(); err != nil {
		return fail(err)
	}
	return &Store{db: db}, nil
}
func (store *Store) Close() error { return store.db.Close() }
func (store *Store) Thread(session string) (string, error) {
	var thread string
	err := store.db.QueryRow("SELECT thread FROM sessions WHERE session=?", session).Scan(&thread)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return thread, err
}
func (store *Store) Set(session, thread string) error {
	if thread == "" {
		_, err := store.db.Exec("DELETE FROM sessions WHERE session=?", session)
		return err
	}
	_, err := store.db.Exec("INSERT INTO sessions VALUES(?,?) ON CONFLICT(session) DO UPDATE SET thread=excluded.thread WHERE thread!=excluded.thread", session, thread)
	return err
}
