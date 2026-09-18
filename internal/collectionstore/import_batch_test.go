package collectionstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	c "github.com/nick1udwig/pebble-agent/internal/collections"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
)

func importFixture(t *testing.T, count int) (*Store, p.Binding, []p.Remote) {
	t.Helper()
	s, _ := fixture(t)
	binding := p.Binding{ID: "notes", Provider: "fake", CollectionID: "col_note", Generation: "1", Container: "remote"}
	if err := s.Bind(binding, "1", false, false); err != nil {
		t.Fatal(err)
	}
	records := make([]p.Remote, count)
	for i := range records {
		records[i] = p.Remote{ID: fmt.Sprint(i), Version: "v1", Container: "remote", Record: c.Record{Kind: "note", Title: fmt.Sprint(i), Body: strings.Repeat("José 🌙 ", 128), BodyComplete: true}}
	}
	return s, binding, records
}

func TestImportBatchRollbackAndReplay(t *testing.T) {
	for _, point := range []string{"import.record", "import.before_commit", "import.after_commit"} {
		t.Run(point, func(t *testing.T) {
			s, b, records := importFixture(t, 70)
			calls := 0
			s.Fault = func(p string) error {
				if p == point {
					calls++
					if calls == 2 {
						return errors.New("interrupted")
					}
				}
				return nil
			}
			if err := s.ImportBatch(b, records); err == nil {
				t.Fatal("fault missed")
			}
			var count int
			if err := s.DB.QueryRow("SELECT count(*) FROM records").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if point == "import.record" && count != 0 {
				t.Fatal("partial record committed")
			}
			s.Fault = nil
			if err := s.ImportBatch(b, records); err != nil {
				t.Fatal(err)
			}
			for _, table := range []string{"records", "versions", "version_bodies", "body_chunks", "changes", "mappings"} {
				if err := s.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 70 {
					t.Fatalf("%s: %d rows after replay", table, count)
				}
			}
		})
	}
}

func TestImportBatchMeasurements(t *testing.T) {
	for _, mode := range []string{"unchanged", "changed", "mixed"} {
		for _, batch := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/batch=%v", mode, batch), func(t *testing.T) {
				s, b, records := importFixture(t, 1000)
				if err := s.ImportBatch(b, records); err != nil {
					t.Fatal(err)
				}
				for i := range records {
					if mode == "changed" || mode == "mixed" && i%2 == 0 {
						records[i].Version = "v2"
						records[i].Record.Title += " changed"
					}
				}
				if _, err := s.DB.Exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0"); err != nil {
					t.Fatal(err)
				}
				var dbFile string
				var seq int
				var name string
				if err := s.DB.QueryRow("PRAGMA database_list").Scan(&seq, &name, &dbFile); err != nil {
					t.Fatal(err)
				}
				commits := 0
				s.Fault = func(point string) error {
					if point == "import.after_commit" {
						commits++
					}
					return nil
				}
				stop := make(chan struct{})
				var wg sync.WaitGroup
				var maxRead time.Duration
				wg.Add(1)
				go func() {
					defer wg.Done()
					for {
						select {
						case <-stop:
							return
						default:
						}
						started := time.Now()
						var n int
						if err := s.DB.QueryRow("SELECT count(*) FROM record_summaries").Scan(&n); err != nil {
							return
						}
						if elapsed := time.Since(started); elapsed > maxRead {
							maxRead = elapsed
						}
					}
				}()
				started := time.Now()
				var err error
				if batch {
					err = s.ImportBatch(b, records)
				} else {
					for _, r := range records {
						if err = s.Import(b, r); err != nil {
							break
						}
					}
				}
				elapsed := time.Since(started)
				close(stop)
				wg.Wait()
				if err != nil {
					t.Fatal(err)
				}
				wal, err := os.Stat(filepath.Clean(dbFile) + "-wal")
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("transactions=%d elapsed=%s WAL=%d max concurrent read=%s", commits, elapsed, wal.Size(), maxRead)
				if batch && commits >= 1000 {
					t.Fatal("imports not batched")
				}
			})
		}
	}
}
