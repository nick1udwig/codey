package collectionstore

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	c "github.com/nick1udwig/pebble-agent/internal/collections"
)

func TestBodyChunkMigrationAndBackup(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("a🌙漢", 32768)
	record := c.Record{ID: "old", Revision: "1", Kind: "event", Body: body, Description: body, BodyHash: c.Hash(body), BodyComplete: true}
	if _, err = s.DB.Exec("DROP TABLE body_chunks; DROP TABLE version_bodies; PRAGMA user_version=2"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("INSERT INTO versions VALUES(?,?,?)", record.ID, record.Revision, encode(record)); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	check := func(store *Store) {
		t.Helper()
		var result strings.Builder
		cursor := ""
		for {
			page, err := store.Body("old", "1", cursor, 704)
			if err != nil {
				t.Fatal(err)
			}
			text := page["body"].(string)
			if !utf8.ValidString(text) || len(text) > 704 {
				t.Fatal("invalid page boundary")
			}
			if page["body_hash"] != record.BodyHash || page["body_complete"] != true {
				t.Fatal("metadata changed")
			}
			result.WriteString(text)
			cursor = page["next_cursor"].(string)
			if page["complete"] != (cursor == "") {
				t.Fatal("final flag mismatch")
			}
			if cursor == "" {
				break
			}
		}
		if result.String() != body {
			t.Fatal("body changed")
		}
		full, err := store.Record("old", "1")
		if err != nil || full.Body != body || full.Description != body {
			t.Fatal("full revision reconstruction failed", err)
		}
	}
	check(s)
	var metadata string
	if err = s.DB.QueryRow("SELECT data FROM versions WHERE record_id='old'").Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(metadata, `"body":`) {
		t.Fatal("body remains duplicated in revision JSON")
	}
	backup := filepath.Join(t.TempDir(), "collections.db")
	if err = s.Backup(backup); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(filepath.Dir(backup))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	check(restored)
	wrong := s.cursor("body", "old:2", 4)
	if _, err = s.Body("old", "1", wrong, 704); err == nil {
		t.Fatal("wrong revision cursor accepted")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = writeVersion(tx, c.Record{ID: "empty", Revision: "1", BodyHash: c.Hash(""), BodyComplete: true}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	empty, err := s.Body("empty", "1", "", 704)
	if err != nil || empty["body"] != "" || empty["complete"] != true {
		t.Fatal(empty, err)
	}
}

func BenchmarkBodyChunkPages(b *testing.B) {
	for _, size := range []int{1024, 65536, 262144} {
		for _, unicode := range []bool{false, true} {
			b.Run(fmt.Sprintf("bytes=%d/unicode=%v", size, unicode), func(b *testing.B) {
				s, err := Open(b.TempDir())
				if err != nil {
					b.Fatal(err)
				}
				defer s.Close()
				unit := "x"
				if unicode {
					unit = "🌙"
				}
				body := strings.Repeat(unit, size/len(unit))
				tx, err := s.DB.Begin()
				if err != nil {
					b.Fatal(err)
				}
				if err = writeVersion(tx, c.Record{ID: "note", Revision: "1", Body: body, BodyHash: c.Hash(body), BodyComplete: true}); err != nil {
					b.Fatal(err)
				}
				if err = tx.Commit(); err != nil {
					b.Fatal(err)
				}
				for _, position := range []int{0, size / 2, size - 512} {
					b.Run(fmt.Sprint(position), func(b *testing.B) {
						token := ""
						if position > 0 {
							token = s.cursor("body", "note:1", int64(position))
						}
						b.ReportAllocs()
						b.ResetTimer()
						for i := 0; i < b.N; i++ {
							if _, err := s.Body("note", "1", token, 704); err != nil {
								b.Fatal(err)
							}
						}
					})
				}
			})
		}
	}
}
