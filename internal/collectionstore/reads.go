package collectionstore

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type Page struct {
	Records    []c.Record `json:"records"`
	Next       string     `json:"next_cursor,omitempty"`
	Cursor     string     `json:"cursor,omitempty"`
	SnapshotID string     `json:"snapshot_id,omitempty"`
	Complete   bool       `json:"complete"`
}
type cursor struct {
	Epoch    string `json:"epoch"`
	Kind     string `json:"kind"`
	Scope    string `json:"scope"`
	Position int64  `json:"position"`
}

func (s *Store) cursor(kind, scope string, pos int64) string {
	b := encode(cursor{s.Epoch, kind, scope, pos})
	h := hmac.New(sha256.New, []byte(s.cursorKey))
	h.Write(b)
	return base64.RawURLEncoding.EncodeToString(b) + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func (s *Store) parse(token, kind, scope string) (int64, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return 0, c.Fail("cursor_expired", "Invalid cursor; refresh required")
	}
	b, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return 0, c.Fail("cursor_expired", "Invalid cursor")
	}
	sig, e := base64.RawURLEncoding.DecodeString(parts[1])
	h := hmac.New(sha256.New, []byte(s.cursorKey))
	h.Write(b)
	var v cursor
	if e != nil || !hmac.Equal(sig, h.Sum(nil)) || json.Unmarshal(b, &v) != nil || v.Epoch != s.Epoch || v.Kind != kind || v.Scope != scope || v.Position < 0 {
		return 0, c.Fail("cursor_expired", "Cursor scope or epoch changed")
	}
	return v.Position, nil
}
func limit(n int) int {
	if n <= 0 {
		return 100
	}
	if n > 200 {
		return 200
	}
	return n
}
func (s *Store) Snapshot(collection, state string) (Page, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.DB.Begin()
	if e != nil {
		return Page{}, e
	}
	defer tx.Rollback()
	var count int
	if e = tx.QueryRow("SELECT count(*) FROM collections WHERE id=? AND principal=?", collection, c.Principal).Scan(&count); e != nil {
		return Page{}, e
	}
	if count != 1 {
		return Page{}, c.Fail("permission_denied", "Unknown collection")
	}
	var seq int64
	if e = tx.QueryRow("SELECT COALESCE(MAX(sequence),0) FROM changes").Scan(&seq); e != nil {
		return Page{}, e
	}
	rows, e := tx.Query("SELECT data FROM records WHERE collection_id=? ORDER BY id", collection)
	if e != nil {
		return Page{}, e
	}
	records := []c.Record{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			rows.Close()
			return Page{}, e
		}
		r, err := Decode[c.Record](b)
		if err != nil {
			rows.Close()
			return Page{}, err
		}
		if !r.Deleted && (state == "all" || r.Kind == "note" || r.Completed == (state == "completed")) {
			records = append(records, r.Summary())
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return Page{}, e
	}
	id := c.ID("snap_")
	cur := s.cursor("changes", collection, seq)
	if _, e = tx.Exec("DELETE FROM snapshots WHERE expires<?", time.Now().Unix()); e != nil {
		return Page{}, e
	}
	if _, e = tx.Exec("INSERT INTO snapshots VALUES(?,?,?,?,?)", id, s.Epoch, time.Now().Add(15*time.Minute).Unix(), cur, encode(records)); e != nil {
		return Page{}, e
	}
	if e = tx.Commit(); e != nil {
		return Page{}, e
	}
	return Page{SnapshotID: id, Cursor: cur, Records: []c.Record{}}, nil
}
func (s *Store) SnapshotPage(id, token string, n int) (Page, error) {
	var epoch, cur string
	var expires int64
	var b []byte
	if e := s.DB.QueryRow("SELECT epoch,expires,cursor,data FROM snapshots WHERE id=?", id).Scan(&epoch, &expires, &cur, &b); e != nil {
		return Page{}, c.Fail("cursor_expired", "Snapshot unavailable")
	}
	if epoch != s.Epoch || expires < time.Now().Unix() {
		return Page{}, c.Fail("cursor_expired", "Snapshot expired")
	}
	var pos int64
	var e error
	if token != "" {
		pos, e = s.parse(token, "snapshot", id)
		if e != nil {
			return Page{}, e
		}
	}
	records, e := Decode[[]c.Record](b)
	if e != nil {
		return Page{}, e
	}
	if pos > int64(len(records)) {
		return Page{}, c.Fail("cursor_expired", "Invalid snapshot offset")
	}
	end := min(int(pos)+limit(n), len(records))
	page := Page{SnapshotID: id, Cursor: cur, Records: records[int(pos):end], Complete: end == len(records)}
	if !page.Complete {
		page.Next = s.cursor("snapshot", id, int64(end))
	}
	return page, nil
}
func (s *Store) Changes(collection, token string, n int) (map[string]any, error) {
	pos, e := s.parse(token, "changes", collection)
	if e != nil {
		return nil, e
	}
	rows, e := s.DB.Query("SELECT sequence,data FROM changes WHERE collection_id=? AND sequence>? ORDER BY sequence LIMIT ?", collection, pos, limit(n))
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []c.Change{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&pos, &b); e != nil {
			return nil, e
		}
		r, e := Decode[c.Record](b)
		if e != nil {
			return nil, e
		}
		out = append(out, c.Change{Sequence: strconv.FormatInt(pos, 10), Record: r})
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	return map[string]any{"changes": out, "cursor": s.cursor("changes", collection, pos), "complete": len(out) < limit(n)}, nil
}
func (s *Store) Body(id, revision, token string, n int) (map[string]any, error) {
	if revision == "" {
		return nil, c.Fail("invalid_input", "Body reads require a revision")
	}
	r, e := s.Record(id, revision)
	if e != nil {
		return nil, e
	}
	var start int64
	if token != "" {
		start, e = s.parse(token, "body", id+":"+revision)
		if e != nil {
			return nil, e
		}
	}
	if start > int64(len(r.Body)) {
		return nil, c.Fail("cursor_expired", "Invalid body position")
	}
	if n <= 0 {
		n = 16384
	}
	n = min(n, 65536)
	if n < 4 {
		return nil, c.Fail("invalid_input", "Body range must allow at least four bytes")
	}
	end := min(int(start)+n, len(r.Body))
	for end < len(r.Body) && !utf8.RuneStart(r.Body[end]) {
		end--
	}
	next := ""
	if end < len(r.Body) {
		next = s.cursor("body", id+":"+revision, int64(end))
	}
	return map[string]any{"id": id, "revision": revision, "body": r.Body[int(start):end], "body_hash": r.BodyHash, "body_complete": r.BodyComplete, "next_cursor": next, "complete": next == ""}, nil
}
func (s *Store) Conflicts() ([]c.Conflict, error) {
	rows, e := s.DB.Query("SELECT data FROM conflicts ORDER BY id")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []c.Conflict{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			return nil, e
		}
		v, e := Decode[c.Conflict](b)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Backup produces a consistent standalone SQLite database, including receipts and pending work.
// The separately held encryption key must be backed up by the operator as well.
func (s *Store) Backup(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !filepath.IsAbs(path) {
		return c.Fail("invalid_input", "Backup path must be absolute")
	}
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	f.Close()
	_, e = s.DB.Exec("VACUUM INTO '" + strings.ReplaceAll(path, "'", "''") + "'")
	return e
}
func (s *Store) RestoreEpoch() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	epoch := c.ID("")
	if _, e = tx.Exec("UPDATE metadata SET value=? WHERE key='store_epoch'", epoch); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE provider_jobs SET state='recovery_required' WHERE state!='applied'"); e != nil {
		return e
	}
	if _, e = tx.Exec("INSERT OR REPLACE INTO metadata VALUES('provider_paused','true')"); e != nil {
		return e
	}
	if e = tx.Commit(); e == nil {
		s.Epoch = epoch
	}
	return e
}
func (s *Store) Status() (map[string]any, error) {
	var pending, attention int
	for _, entry := range []struct {
		sql  string
		dest *int
	}{{"SELECT count(*) FROM provider_jobs WHERE state='pending'", &pending}, {"SELECT count(*) FROM conflicts WHERE json_extract(data,'$.resolved')=0", &attention}} {
		if e := s.DB.QueryRow(entry.sql).Scan(entry.dest); e != nil {
			return nil, e
		}
	}
	return map[string]any{"provider_pending": pending, "needs_attention": attention, "store_epoch": s.Epoch}, nil
}
func ErrorCode(e error) string {
	if v, ok := e.(*c.Error); ok {
		return v.Code
	}
	return fmt.Sprint("storage_error")
}
