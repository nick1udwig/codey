package collectionstore

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func measureProviderWrites(t *testing.T, s *Store) {
	t.Helper()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	start := time.Now()
	for i := 0; i < 1000; i++ {
		if _, err = tx.Exec("INSERT INTO provider_jobs VALUES(?,?,?,?,?,?)", "write"+fmt.Sprint(i), "binding", "record", "1", "pending", `{}`); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("1000 pending inserts, rolled back: %s", time.Since(start))
}

func TestProviderIndexesHistoryAndMigration(t *testing.T) {
	for _, history := range []int{100, 10000, 100000} {
		t.Run(fmt.Sprint(history), func(t *testing.T) {
			dir := t.TempDir()
			s, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			// Model an existing v2 store lacking the newly added indexes.
			for _, index := range []string{"provider_jobs_unfinished_binding", "provider_jobs_unfinished_record", "mappings_record"} {
				if _, err = s.DB.Exec("DROP INDEX " + index); err != nil {
					t.Fatal(err)
				}
			}
			tx, err := s.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			stmt, err := tx.Prepare("INSERT INTO provider_jobs VALUES(?,?,?,?,?,?)")
			if err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			for i := 0; i < history; i++ {
				if _, err = stmt.Exec(fmt.Sprint(i), "binding", "record", "1", "applied", `{}`); err != nil {
					t.Fatal(err)
				}
			}
			stmt.Close()
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
			t.Logf("historical fixture insertion: %s", time.Since(started))
			states := []string{"pending", "in_flight", "delivery_unknown", "in_progress", "recovery_required", "conflict", "failed"}
			for i, state := range states {
				if _, err = s.DB.Exec("INSERT INTO provider_jobs VALUES(?,?,?,?,?,?)", "active"+fmt.Sprint(i), "binding", "record", "1", state, `{}`); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = s.DB.Exec("INSERT INTO provider_jobs VALUES('other','other','record','1','pending','{}')"); err != nil {
				t.Fatal(err)
			}
			measureProviderWrites(t, s)
			var beforePages, pageSize int
			s.DB.QueryRow("PRAGMA page_count").Scan(&beforePages)
			s.DB.QueryRow("PRAGMA page_size").Scan(&pageSize)
			t.Logf("database bytes before: %d", beforePages*pageSize)
			s.Close()
			started = time.Now()
			s, err = Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			t.Logf("index migration: %s", time.Since(started))
			measureProviderWrites(t, s)
			queries := []struct{ sql, index string }{
				{"SELECT data FROM mappings WHERE binding_id='binding' AND record_id='record'", "mappings_record"},
				{"SELECT id FROM provider_jobs WHERE binding_id='binding' AND state NOT IN ('applied','stopped') ORDER BY rowid", "provider_jobs_unfinished_binding"},
				{"SELECT count(*) FROM provider_jobs WHERE binding_id='binding' AND record_id='record' AND state NOT IN ('applied','stopped')", "provider_jobs_unfinished_record"},
			}
			for _, query := range queries {
				rows, err := s.DB.Query("EXPLAIN QUERY PLAN " + query.sql)
				if err != nil {
					t.Fatal(err)
				}
				var plan string
				for rows.Next() {
					var a, b, c int
					var detail string
					if err = rows.Scan(&a, &b, &c, &detail); err != nil {
						t.Fatal(err)
					}
					plan += detail
				}
				rows.Close()
				if !strings.Contains(plan, query.index) || strings.Contains(plan, "TEMP B-TREE") {
					t.Fatal(plan)
				}
			}
			started = time.Now()
			for n := 0; n < 100; n++ {
				jobs, err := s.Pending("binding")
				if err != nil {
					t.Fatal(err)
				}
				if len(jobs) != len(states) {
					t.Fatalf("%d jobs", len(jobs))
				}
				for i, j := range jobs {
					if j.State != states[i] {
						t.Fatal("FIFO changed")
					}
				}
			}
			t.Logf("100 pending reads: %s", time.Since(started))
			var pages, size int
			s.DB.QueryRow("PRAGMA page_count").Scan(&pages)
			s.DB.QueryRow("PRAGMA page_size").Scan(&size)
			t.Logf("database bytes: %d", pages*size)
		})
	}
}
