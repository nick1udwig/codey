package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type diskState struct {
	Version  int               `json:"version"`
	Sessions map[string]string `json:"sessions"`
}

type Store struct {
	path string

	mu       sync.RWMutex
	sessions map[string]string
}

func Open(path string) (*Store, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("state path must be absolute: %q", path)
	}
	store := &Store{path: path, sessions: make(map[string]string)}
	payload, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read state: %w", err)
	}
	var current diskState
	if err := json.Unmarshal(payload, &current); err != nil {
		return nil, fmt.Errorf("decode state: %w", err)
	}
	if current.Version != 1 {
		return nil, fmt.Errorf("unsupported state version %d", current.Version)
	}
	if current.Sessions != nil {
		store.sessions = current.Sessions
	}
	return store, nil
}

func (store *Store) Thread(session string) string {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return store.sessions[session]
}

func (store *Store) Set(session, thread string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	next := clone(store.sessions)
	if thread == "" {
		delete(next, session)
	} else {
		next[session] = thread
	}
	if err := store.write(next); err != nil {
		return err
	}
	store.sessions = next
	return nil
}

func (store *Store) write(sessions map[string]string) error {
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	file, err := os.CreateTemp(directory, ".sessions-*.json")
	if err != nil {
		return fmt.Errorf("create state file: %w", err)
	}
	temporary := file.Name()
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(temporary)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(diskState{Version: 1, Sessions: sessions}); err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync state: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close state: %w", err)
	}
	if err := os.Rename(temporary, store.path); err != nil {
		return fmt.Errorf("replace state: %w", err)
	}
	committed = true
	return nil
}

func clone(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
