package logfile

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestWriterRotatesWholeWritesAndExpiresOldBackups(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "server.log")
	w, err := Open(path, 10, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"first\n", "second\n", "third\n", "fourth\n"} {
		if _, err := w.Write([]byte(value)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	assertFileContents(t, path, "fourth\n")
	assertFileContents(t, path+".1", "third\n")
	assertFileContents(t, path+".2", "second\n")
	if _, err := os.Stat(path + ".3"); !os.IsNotExist(err) {
		t.Fatalf("third backup exists or stat failed: %v", err)
	}
}

func TestWriterKeepsOversizedRecordIntact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.log")
	w, err := Open(path, 4, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("oversized-record\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("next\n")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	assertFileContents(t, path+".1", "oversized-record\n")
	assertFileContents(t, path, "next\n")
}

func TestWriterUsesPrivatePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "server.log")
	w, err := Open(path, 1024, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("log permissions = %o, want 600", got)
	}
}

func TestWriterSerializesConcurrentRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.log")
	w, err := Open(path, 1<<20, 2)
	if err != nil {
		t.Fatal(err)
	}
	const writers = 8
	const records = 100
	var group sync.WaitGroup
	for index := 0; index < writers; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for count := 0; count < records; count++ {
				if _, err := w.Write([]byte("record\n")); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	group.Wait()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(contents), "record\n"); got != writers*records {
		t.Fatalf("record count = %d, want %d", got, writers*records)
	}
}

func TestOpenRejectsInvalidConfiguration(t *testing.T) {
	for _, test := range []struct {
		name    string
		path    string
		max     int64
		backups int
	}{
		{name: "empty path", max: 1, backups: 1},
		{name: "zero size", path: "log", backups: 1},
		{name: "zero backups", path: "log", max: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Open(test.path, test.max, test.backups); err == nil {
				t.Fatal("Open succeeded")
			}
		})
	}
}

func assertFileContents(t *testing.T, path, want string) {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(contents); got != want {
		t.Fatalf("%s = %q, want %q", path, got, want)
	}
}
