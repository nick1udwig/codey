package state

import (
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
	if err := store.Set("watch", "thread-1"); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Thread("watch"); got != "thread-1" {
		t.Fatalf("got thread %q", got)
	}
	info, err := os.Stat(path)
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
	if got := again.Thread("watch"); got != "" {
		t.Fatalf("deleted session still maps to %q", got)
	}
}
