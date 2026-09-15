package collectionstore

import (
	"fmt"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"strings"
	"testing"
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
