// Package jobs owns agent work independently of any HTTP connection.
package jobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/nick1udwig/pebble-agent/internal/pam"
)

type Responder interface {
	Respond(context.Context, pam.Request, func([]byte) error) error
}
type Job struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	Title     string    `json:"title"`
	Result    string    `json:"result,omitempty"`
	Error     string    `json:"error,omitempty"`
	Hash      string    `json:"hash,omitempty"`
	Created   time.Time `json:"created"`
	Finished  time.Time `json:"finished,omitempty"`
	Retrieved bool      `json:"retrieved,omitempty"`
}
type entry struct {
	Job
	cancel context.CancelFunc
	done   chan struct{}
}
type Store struct {
	mu        sync.Mutex
	logger    *slog.Logger
	dir       string
	retention time.Duration
	responder Responder
	entries   map[string]*entry
	stop      chan struct{}
	wg        sync.WaitGroup
	closed    bool
}

var ErrMissing = errors.New("job not found (or retention expired)")
var ErrConflict = errors.New("job ID already belongs to another request")
var validID = regexp.MustCompile(`^[a-f0-9]{30}$`)

func ValidID(id string) bool { return validID.MatchString(id) }
func Open(dir string, retention time.Duration, responder Responder, loggers ...*slog.Logger) (*Store, error) {
	if retention < 0 {
		return nil, errors.New("retention must be nonnegative")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, retention: retention, responder: responder, entries: map[string]*entry{}, stop: make(chan struct{})}
	if len(loggers) > 0 {
		s.logger = loggers[0]
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		if filepath.Ext(file.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, file.Name()))
		if err != nil {
			return nil, err
		}
		var j Job
		if err := json.Unmarshal(data, &j); err != nil {
			return nil, fmt.Errorf("load job %s: %w", file.Name(), err)
		}
		if !ValidID(j.ID) || file.Name() != j.ID+".json" {
			return nil, errors.New("invalid stored job ID")
		}
		e := &entry{Job: j, done: make(chan struct{})}
		close(e.done)
		if j.Status == "working" || j.Status == "canceling" {
			e.Status = "failed"
			e.Error = "Server restarted while this request was running. Check any changes before trying again."
			e.Finished = time.Now()
			if err := s.save(e); err != nil {
				return nil, err
			}
		}
		s.entries[j.ID] = e
	}
	s.expire()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-tick.C:
				s.mu.Lock()
				s.expire()
				s.mu.Unlock()
			}
		}
	}()
	return s, nil
}
func (s *Store) save(e *entry) error {
	data, err := json.Marshal(e.Job)
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, e.ID+".json")
	f, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		return err
	}
	directory, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
func (s *Store) expire() {
	if s.retention == 0 {
		return
	}
	for id, e := range s.entries {
		if !e.Finished.IsZero() && time.Since(e.Finished) >= s.retention {
			if os.Remove(filepath.Join(s.dir, id+".json")) == nil {
				delete(s.entries, id)
			}
		}
	}
}
func (s *Store) Submit(id string, request pam.Request) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	if !ValidID(id) {
		return Job{}, errors.New("invalid job ID")
	}
	if s.closed {
		return Job{}, errors.New("server shutting down")
	}
	canonical, err := json.Marshal(struct {
		Raw     string
		Backend pam.BackendOptions
	}{request.Raw, request.Backend})
	if err != nil {
		return Job{}, err
	}
	hash := sha256.Sum256(canonical)
	digest := hex.EncodeToString(hash[:])
	if e := s.entries[id]; e != nil {
		if e.Hash != digest {
			return Job{}, ErrConflict
		}
		return e.Job, nil
	}
	active := 0
	for _, e := range s.entries {
		if e.Status == "working" || e.Status == "canceling" {
			active++
		}
	}
	if active >= 32 {
		return Job{}, errors.New("server has 32 active jobs; try again later")
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &entry{Job: Job{ID: id, Created: time.Now(), Status: "working", Title: request.Input["text"], Hash: digest}, cancel: cancel, done: make(chan struct{})}
	if err := s.save(e); err != nil {
		cancel()
		return Job{}, err
	}
	s.entries[id] = e
	if s.logger != nil {
		s.logger.Info("agent job accepted", "job_id", id, "session", request.Session)
	}
	s.wg.Add(1)
	go s.run(ctx, e, request)
	return e.Job, nil
}
func (s *Store) run(ctx context.Context, e *entry, request pam.Request) {
	defer s.wg.Done()
	defer e.cancel()
	var result []byte
	err := s.responder.Respond(ctx, request, func(data []byte) error {
		if len(result)+len(data) > 512<<10 {
			return errors.New("agent result exceeds 512 KiB")
		}
		result = append(result, data...)
		return nil
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	e.Result = string(result)
	e.Finished = time.Now()
	if s.closed && e.Status != "canceling" && errors.Is(err, context.Canceled) {
		e.Status = "failed"
		e.Result = ""
		e.Error = "Server stopped while this request was running. Check any changes before trying again."
	} else if e.Status == "canceling" || errors.Is(err, context.Canceled) {
		e.Status = "canceled"
		e.Result = ""
		e.Error = "Request canceled. Work already performed is not undone."
	} else if err != nil {
		e.Status = "failed"
		e.Error = err.Error()
	} else {
		e.Status = "done"
	}
	if saveErr := s.save(e); saveErr != nil {
		e.Status = "failed"
		e.Error = "Could not save result: " + saveErr.Error()
	}
	if s.logger != nil {
		s.logger.Info("agent job finished", "job_id", e.ID, "status", e.Status, "elapsed", time.Since(e.Created), "error", e.Error)
	}
	close(e.done)
}
func (s *Store) Get(ctx context.Context, id string, wait time.Duration) (Job, error) {
	s.mu.Lock()
	s.expire()
	e := s.entries[id]
	if e == nil {
		s.mu.Unlock()
		return Job{}, ErrMissing
	}
	done := e.done
	s.mu.Unlock()
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return Job{}, ctx.Err()
		case <-done:
		case <-timer.C:
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return e.Job, nil
}
func (s *Store) Cancel(id string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[id]
	if e == nil {
		return Job{}, ErrMissing
	}
	if e.Status == "working" {
		e.Status = "canceling"
		e.cancel()
	}
	return e.Job, nil
}

// Acknowledge only after the phone has durably cached the full result. Keep the
// ID and hash as a tombstone so a submission retry cannot repeat side effects.
func (s *Store) Acknowledge(id string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[id]
	if e == nil {
		return Job{}, ErrMissing
	}
	if e.Status == "working" || e.Status == "canceling" {
		return Job{}, errors.New("job is still running")
	}
	old := e.Job
	e.Retrieved = true
	e.Result = ""
	if err := s.save(e); err != nil {
		e.Job = old
		return Job{}, err
	}
	return e.Job, nil
}
func (s *Store) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.stop)
	for _, e := range s.entries {
		if e.cancel != nil {
			e.cancel()
		}
	}
	s.mu.Unlock()
	s.wg.Wait()
}
