package state

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestStorePersistsAndDeletesSessionThreads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "sessions.json")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if err := store.Set("watch", "thread-1"); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.Close() })
	if got, err := reopened.Thread("watch"); err != nil || got != "thread-1" {
		t.Fatalf("got thread %q", got)
	}
	info, err := os.Stat(path + ".db")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state mode is %o", info.Mode().Perm())
	}
	if err := reopened.Set("watch", ""); err != nil {
		t.Fatal(err)
	}
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { again.Close() })
	if got, err := again.Thread("watch"); err != nil || got != "" {
		t.Fatalf("deleted session still maps to %q", got)
	}
}

func TestLegacyMigrationPreservesOldJobsAndDoesNotResurrectDeletes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	legacy := []byte(`{"version":1,"sessions":{"old-job-session":"old-thread","deleted":"thread"}}`)
	if err := os.WriteFile(path, legacy, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Set("deleted", ""); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		if err = store.Set(fmt.Sprint(i), "thread"); err != nil {
			t.Fatal(err)
		}
	}
	store.Close()
	restored, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if thread, err := restored.Thread("old-job-session"); err != nil || thread != "old-thread" {
		t.Fatal("old job lost its conversation", thread, err)
	}
	if thread, err := restored.Thread("deleted"); err != nil || thread != "" {
		t.Fatal("legacy snapshot resurrected a deletion", thread, err)
	}
	original, err := os.ReadFile(path)
	if err != nil || string(original) != string(legacy) {
		t.Fatal("legacy source modified", err)
	}
}

func TestFailedMigrationCanRetryAndReadErrorsPropagate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	if err := os.WriteFile(path, []byte(`{"version":1`), 0600); err != nil {
		t.Fatal(err)
	}
	if store, err := Open(path); err == nil {
		store.Close()
		t.Fatal("malformed legacy state accepted")
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"sessions":{"old":"thread"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if thread, err := store.Thread("old"); err != nil || thread != "thread" {
		t.Fatal(thread, err)
	}
	store.Close()
	if _, err := store.Thread("old"); err == nil {
		t.Fatal("read error silently became missing session")
	}
	if err := store.Set("new", "thread"); err == nil {
		t.Fatal("closed store accepted a write")
	}
}

func BenchmarkSessionWritesAfterChurn(b *testing.B) {
	for _, count := range []int{100, 10000} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			store, err := Open(filepath.Join(b.TempDir(), "sessions.json"))
			if err != nil {
				b.Fatal(err)
			}
			defer store.Close()
			tx, err := store.db.Begin()
			if err != nil {
				b.Fatal(err)
			}
			for i := 0; i < count; i++ {
				if _, err = tx.Exec("INSERT INTO sessions VALUES(?,?)", fmt.Sprint(i), "thread"); err != nil {
					b.Fatal(err)
				}
			}
			if err = tx.Commit(); err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if err = store.Set("active", fmt.Sprint(i)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestFailedSessionWriteKeepsPreviousMapping(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "sessions.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Set("watch", "old"); err != nil {
		t.Fatal(err)
	}
	if _, err = store.db.Exec("CREATE TRIGGER reject_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'write failed'); END"); err != nil {
		t.Fatal(err)
	}
	if err = store.Set("watch", "new"); err == nil {
		t.Fatal("write failure ignored")
	}
	if thread, err := store.Thread("watch"); err != nil || thread != "old" {
		t.Fatal("failed write replaced mapping", thread, err)
	}
}
