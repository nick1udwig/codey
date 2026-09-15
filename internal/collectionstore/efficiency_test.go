package collectionstore

import (
	"fmt"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"strings"
	"testing"
	"time"
)

func benchmarkNotes(b *testing.B) *Store {
	b.Helper()
	s, e := Open(b.TempDir())
	if e != nil {
		b.Fatal(e)
	}
	b.Cleanup(func() { s.Close() })
	tx, e := s.DB.Begin()
	if e != nil {
		b.Fatal(e)
	}
	body := strings.Repeat("Notes with Unicode 🌙 and useful details.\n", 1600)
	for i := 0; i < 100; i++ {
		r := c.Record{ID: fmt.Sprintf("note-%03d", i), CollectionID: "col_note", Kind: "note", Title: "Benchmark note", Revision: "1", Body: body, BodyComplete: true, Capabilities: []string{"note.append"}}
		if _, e = tx.Exec("INSERT INTO records VALUES(?,?,?)", r.ID, r.CollectionID, encode(r)); e != nil {
			b.Fatal(e)
		}
	}
	if e = tx.Commit(); e != nil {
		b.Fatal(e)
	}
	return s
}

func TestSnapshotMigrationPreservesIssuedPagesAndSummaryUpdates(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	r := c.Record{ID: "old", CollectionID: "col_note", Kind: "note", Revision: "1", Title: "Pinned", Body: "complete body", BodyComplete: true}
	if _, err = s.DB.Exec("INSERT INTO records VALUES(?,?,?)", r.ID, r.CollectionID, encode(r)); err != nil {
		t.Fatal(err)
	}
	server, epoch := s.ServerID, s.Epoch
	// Recreate the previous disk format, including a live immutable snapshot.
	_, err = s.DB.Exec(`DROP TABLE snapshot_records; DROP TABLE snapshots;
 CREATE TABLE snapshots(id TEXT PRIMARY KEY,epoch TEXT NOT NULL,expires INTEGER NOT NULL,cursor TEXT NOT NULL,data BLOB NOT NULL);
 DROP TRIGGER summary_insert; DROP TRIGGER summary_update; DROP TRIGGER summary_delete; DROP TABLE record_summaries;
 PRAGMA user_version=1;`)
	if err != nil {
		t.Fatal(err)
	}
	token := s.cursor("snapshot", "issued", 0)
	if _, err = s.DB.Exec("INSERT INTO snapshots VALUES(?,?,?,?,?)", "issued", epoch, time.Now().Add(time.Hour).Unix(), "changes", encode([]c.Record{r.Summary()})); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.ServerID != server || s.Epoch != epoch {
		t.Fatal("identity changed")
	}
	page, err := s.SnapshotPage("issued", token, 8)
	if err != nil || len(page.Records) != 1 || page.Records[0].Title != "Pinned" {
		t.Fatal(page, err)
	}
	r.Title = "Updated"
	r.Revision = "2"
	if _, err = s.DB.Exec("UPDATE records SET data=? WHERE id=?", encode(r), r.ID); err != nil {
		t.Fatal(err)
	}
	fresh, err := s.SnapshotFirstPage("col_note", "active", 0, 8)
	if err != nil || fresh.Records[0].Title != "Updated" || fresh.Records[0].Body != "" {
		t.Fatal(fresh, err)
	}
	if _, err = s.DB.Exec("DELETE FROM records WHERE id=?", r.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	s.DB.QueryRow("SELECT count(*) FROM record_summaries").Scan(&n)
	if n != 0 {
		t.Fatal(n)
	}
	page, err = s.SnapshotPage("issued", token, 8)
	if err != nil || page.Records[0].Title != "Pinned" {
		t.Fatal(page, err)
	}
	if _, err = s.DB.Exec("UPDATE snapshots SET expires=0 WHERE id='issued'"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SnapshotPage("issued", token, 8); err == nil {
		t.Fatal("expired snapshot accepted")
	}
	if _, err = s.Snapshot("col_note", "active"); err != nil {
		t.Fatal(err)
	}
	s.DB.QueryRow("SELECT count(*) FROM snapshot_records WHERE snapshot_id='issued'").Scan(&n)
	if n != 0 {
		t.Fatal("orphan snapshot records", n)
	}
}

func TestSnapshotPageReadsOnlyRequestedRows(t *testing.T) {
	s, _ := fixture(t)
	for i := 0; i < 20; i++ {
		r := c.Record{ID: fmt.Sprintf("n%02d", i), Kind: "note", CollectionID: "col_note"}
		if _, err := s.DB.Exec("INSERT INTO records VALUES(?,?,?)", r.ID, r.CollectionID, encode(r)); err != nil {
			t.Fatal(err)
		}
	}
	p, err := s.SnapshotFirstPage("col_note", "active", 0, 8)
	if err != nil {
		t.Fatal(err)
	}
	// Malformed data outside the requested page proves there is no full-array decode.
	if _, err = s.DB.Exec("UPDATE snapshot_records SET data='invalid JSON' WHERE snapshot_id=? AND position=19", p.SnapshotID); err != nil {
		t.Fatal(err)
	}
	next, err := s.SnapshotPage(p.SnapshotID, p.Next, 8)
	if err != nil || len(next.Records) != 8 || next.Total != 20 {
		t.Fatal(next, err)
	}
	if _, err = s.SnapshotPage(p.SnapshotID, next.Next, 8); err == nil {
		t.Fatal("corrupt requested row accepted")
	}
	if _, err = s.SnapshotPage(p.SnapshotID, s.cursor("snapshot", "another", 0), 8); err == nil {
		t.Fatal("foreign cursor accepted")
	}
	if _, err = s.SnapshotPage(p.SnapshotID, s.cursor("snapshot", p.SnapshotID, 21), 8); err == nil {
		t.Fatal("out-of-range cursor accepted")
	}
}

func BenchmarkSnapshotScale(b *testing.B) {
	for _, n := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			s, err := Open(b.TempDir())
			if err != nil {
				b.Fatal(err)
			}
			defer s.Close()
			tx, err := s.DB.Begin()
			if err != nil {
				b.Fatal(err)
			}
			for i := 0; i < n; i++ {
				r := c.Record{ID: fmt.Sprintf("n%05d", i), Kind: "note", CollectionID: "col_note", Title: "Note", Body: strings.Repeat("x", 1024)}
				if _, err = tx.Exec("INSERT INTO records VALUES(?,?,?)", r.ID, r.CollectionID, encode(r)); err != nil {
					b.Fatal(err)
				}
			}
			if err = tx.Commit(); err != nil {
				b.Fatal(err)
			}
			b.Run("first", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if _, err := s.SnapshotFirstPage("col_note", "active", 0, 8); err != nil {
						b.Fatal(err)
					}
				}
			})
			p, err := s.SnapshotFirstPage("col_note", "active", 0, 8)
			if err != nil {
				b.Fatal(err)
			}
			b.Run("later", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if _, err := s.SnapshotPage(p.SnapshotID, p.Next, 8); err != nil {
						b.Fatal(err)
					}
				}
			})
		})
	}
}
func BenchmarkCollectionCounts(b *testing.B) {
	s := benchmarkNotes(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		cols, e := s.Collections()
		if e != nil {
			b.Fatal(e)
		}
		for _, col := range cols {
			if col.Kind == "note" && col.Count != 100 {
				b.Fatal(col.Count)
			}
		}
	}
}
func BenchmarkNoteSnapshot(b *testing.B) {
	s := benchmarkNotes(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p, e := s.Snapshot("col_note", "active")
		if e != nil || p.Total != 100 {
			b.Fatal(p, e)
		}
	}
}

func TestFirstPageProjectionAndPinnedPagination(t *testing.T) {
	s, _ := fixture(t)
	for i := 0; i < 10; i++ {
		r := c.Record{ID: fmt.Sprintf("n%02d", i), CollectionID: "col_note", Kind: "note", Title: "Original", Revision: "1", Body: strings.Repeat("🌙", 10000), Description: "Details", Extensions: []byte(`{"private":"value"}`), BodyComplete: true, Capabilities: []string{"note.append"}}
		if _, err := s.DB.Exec("INSERT INTO records VALUES(?,?,?)", r.ID, r.CollectionID, encode(r)); err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.SnapshotFirstPage("col_note", "active", 0, 8)
	if err != nil || len(first.Records) != 8 || first.Total != 10 || first.Next == "" || first.Complete {
		t.Fatal(first, err)
	}
	for _, r := range first.Records {
		if r.Body != "" || r.Description != "" || r.Extensions != nil || !r.BodyComplete || len(r.Capabilities) != 1 {
			t.Fatal("summary changed", r)
		}
	}
	original, err := s.Record("n00", "")
	if err != nil || len(original.Body) != 40000 || original.Description != "Details" || original.Extensions == nil {
		t.Fatal("canonical body changed", err)
	}
	if _, err = s.DB.Exec(`UPDATE records SET data=json_set(data,'$.title','Changed','$.deleted',json('true'))`); err != nil {
		t.Fatal(err)
	}
	next, err := s.SnapshotPage(first.SnapshotID, first.Next, 8)
	if err != nil || len(next.Records) != 2 || !next.Complete || next.Total != 10 || next.Records[0].Title != "Original" {
		t.Fatal(next, err)
	}
	fresh, err := s.SnapshotFirstPage("col_note", "active", 0, 8)
	if err != nil || len(fresh.Records) != 0 || !fresh.Complete {
		t.Fatal(fresh, err)
	}
	cols, err := s.Collections()
	if err != nil {
		t.Fatal(err)
	}
	for _, col := range cols {
		if col.Count != 0 {
			t.Fatal("deleted records counted", col)
		}
	}
}

func TestIndexedCountsMatchVisibleRecords(t *testing.T) {
	s, _ := fixture(t)
	records := []c.Record{
		{Kind: "task"}, {Kind: "task", Completed: true}, {Kind: "task", Deleted: true},
		{Kind: "note"}, {Kind: "note", Deleted: true}, {Kind: "note", Completed: true},
		{Kind: "event", End: "2099-01-02"}, {Kind: "event", End: "2000-01-02"},
		{Kind: "event", End: "2099-01-02T00:00:00Z", Deleted: true}, {Kind: "event", End: "invalid"},
	}
	for i, r := range records {
		r.ID = fmt.Sprint(i)
		r.CollectionID = "col_" + r.Kind
		if _, err := s.DB.Exec("INSERT INTO records VALUES(?,?,?)", r.ID, r.CollectionID, encode(r)); err != nil {
			t.Fatal(err)
		}
	}
	for _, offset := range []int{-840, 0, 840} {
		cols, err := s.CollectionsInZone(offset)
		if err != nil {
			t.Fatal(err)
		}
		for _, col := range cols {
			page, err := s.SnapshotFirstPage(col.ID, "active", offset, 8)
			if err != nil || page.Total != col.Count {
				t.Fatal(col, page, err)
			}
		}
	}
}

func TestExistingStoreBuildsCountIndexWithoutChangingIdentity(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	server, epoch := s.ServerID, s.Epoch
	r := c.Record{ID: "existing", CollectionID: "col_note", Kind: "note", Body: "Keep me"}
	if _, err = s.DB.Exec("INSERT INTO records VALUES(?,?,?)", r.ID, r.CollectionID, encode(r)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("DROP INDEX records_collection_state"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.ServerID != server || s.Epoch != epoch {
		t.Fatal("store identity changed")
	}
	cols, err := s.Collections()
	if err != nil {
		t.Fatal(err)
	}
	for _, col := range cols {
		if col.Kind == "note" && col.Count != 1 {
			t.Fatal(col)
		}
	}
	record, err := s.Record(r.ID, "")
	if err != nil || record.Body != r.Body {
		t.Fatal(record, err)
	}
	var count int
	if err = s.DB.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='index' AND name='records_collection_state'").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
}
