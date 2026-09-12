package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/nick1udwig/pebble-agent/internal/pam"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type worker struct {
	calls   atomic.Int32
	start   chan struct{}
	release chan struct{}
}

func (w *worker) Respond(ctx context.Context, _ pam.Request, emit func([]byte) error) error {
	w.calls.Add(1)
	w.start <- struct{}{}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-w.release:
		return emit([]byte("pam version=1\nscreen id=a layout=text title=Ready\ndone\n"))
	}
}

const jobID = "123456789012345678901234567890"

func request() pam.Request {
	return pam.Request{Session: "session", Raw: "original", Input: map[string]string{"text": "Long task"}}
}
func TestDisconnectPersistenceAndIdempotency(t *testing.T) {
	w := &worker{start: make(chan struct{}, 2), release: make(chan struct{})}
	dir := t.TempDir()
	s, err := Open(dir, 0, w)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Submit(jobID, request()); err != nil {
		t.Fatal(err)
	}
	<-w.start
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = s.Get(ctx, jobID, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err = s.Submit(jobID, request()); err != nil {
		t.Fatal(err)
	}
	changed := request()
	changed.Raw = "other"
	if _, err = s.Submit(jobID, changed); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if w.calls.Load() != 1 {
		t.Fatal("duplicate execution")
	}
	close(w.release)
	j, err := s.Get(context.Background(), jobID, time.Second)
	if err != nil || j.Status != "done" || j.Result == "" {
		t.Fatalf("%+v %v", j, err)
	}
	s.Close()
	s, err = Open(dir, 0, w)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	j, err = s.Get(context.Background(), jobID, 0)
	if err != nil || j.Result == "" {
		t.Fatal("result lost on restart")
	}
	if _, err = s.Acknowledge(jobID); err != nil {
		t.Fatal(err)
	}
	j, _ = s.Submit(jobID, request())
	if !j.Retrieved || j.Result != "" || w.calls.Load() != 1 {
		t.Fatal("retrieval tombstone lost")
	}
}
func TestCancelAndWaitDeadline(t *testing.T) {
	w := &worker{start: make(chan struct{}, 1), release: make(chan struct{})}
	s, err := Open(t.TempDir(), 0, w)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.Submit(jobID, request())
	<-w.start
	j, err := s.Get(context.Background(), jobID, time.Millisecond)
	if err != nil || j.Status != "working" {
		t.Fatalf("%+v %v", j, err)
	}
	if _, err = s.Acknowledge(jobID); err == nil {
		t.Fatal("acknowledged running job")
	}
	if _, err = s.Cancel(jobID); err != nil {
		t.Fatal(err)
	}
	j, err = s.Get(context.Background(), jobID, time.Second)
	if err != nil || j.Status != "canceled" {
		t.Fatalf("%+v %v", j, err)
	}
}
func TestRecoveryAndRetention(t *testing.T) {
	for _, status := range []string{"working", "canceling", "done"} {
		t.Run(status, func(t *testing.T) {
			dir := t.TempDir()
			j := Job{ID: jobID, Status: status, Result: "saved", Finished: time.Now().Add(-48 * time.Hour)}
			data, _ := json.Marshal(j)
			if err := os.WriteFile(filepath.Join(dir, jobID+".json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			s, err := Open(dir, 24*time.Hour, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			got, err := s.Get(context.Background(), jobID, 0)
			if status == "done" {
				if !errors.Is(err, ErrMissing) {
					t.Fatal("did not expire")
				}
			} else if err != nil || got.Status != "failed" {
				t.Fatalf("%+v %v", got, err)
			}
		})
	}
}

func TestShutdownReportsInterruption(t *testing.T) {
	w := &worker{start: make(chan struct{}, 1), release: make(chan struct{})}
	dir := t.TempDir()
	s, err := Open(dir, 0, w)
	if err != nil {
		t.Fatal(err)
	}
	s.Submit(jobID, request())
	<-w.start
	s.Close()
	s, err = Open(dir, 0, w)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	j, err := s.Get(context.Background(), jobID, 0)
	if err != nil || j.Status != "failed" {
		t.Fatalf("%+v %v", j, err)
	}
}
