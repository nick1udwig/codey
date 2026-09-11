// Package logfile provides the server's small, dependency-free rotating log.
package logfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	// DefaultMaxBytes is the maximum size of an individual log file before the
	// next complete record is written to a new file.
	DefaultMaxBytes int64 = 10 * 1024 * 1024
	// DefaultBackups keeps the five most recent rotated files.
	DefaultBackups = 5
)

// Writer appends to a file and rotates it before a write would cross maxBytes.
// A single write larger than maxBytes is kept intact in one file.
type Writer struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	backups  int
	file     *os.File
	size     int64
}

// Open creates a rotating writer. The log file is always restricted to the
// current user because it can contain dictated text and complete model output.
func Open(path string, maxBytes int64, backups int) (*Writer, error) {
	if path == "" {
		return nil, errors.New("log file path must not be empty")
	}
	if maxBytes <= 0 {
		return nil, errors.New("log maximum size must be positive")
	}
	if backups < 1 {
		return nil, errors.New("log backup count must be positive")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}
	w := &Writer{path: path, maxBytes: maxBytes, backups: backups}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *Writer) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return fmt.Errorf("protect log file: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return fmt.Errorf("stat log file: %w", err)
	}
	w.file = file
	w.size = info.Size()
	return nil
}

func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return 0, os.ErrClosed
	}
	if w.size > 0 && w.size+int64(len(p)) > w.maxBytes {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *Writer) rotate() error {
	if err := w.file.Close(); err != nil {
		return fmt.Errorf("close log for rotation: %w", err)
	}
	w.file = nil

	oldest := w.rotatedPath(w.backups)
	if err := os.Remove(oldest); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove oldest log backup: %w", err)
	}
	for index := w.backups - 1; index >= 1; index-- {
		from := w.rotatedPath(index)
		to := w.rotatedPath(index + 1)
		if err := os.Rename(from, to); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("rotate log backup: %w", err)
		}
	}
	if err := os.Rename(w.path, w.rotatedPath(1)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("rotate active log: %w", err)
	}
	if err := w.open(); err != nil {
		return fmt.Errorf("open new log after rotation: %w", err)
	}
	return nil
}

func (w *Writer) rotatedPath(index int) string {
	return fmt.Sprintf("%s.%d", w.path, index)
}

func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}
