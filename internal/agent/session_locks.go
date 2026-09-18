package agent

import (
	"context"
	"sync"
)

type sessionLock struct {
	token chan struct{}
	users int
}
type sessionLocks struct {
	mu      sync.Mutex
	entries map[string]*sessionLock
}

// Count waiters before they can block. Removal is safe only after both the
// owner and every waiter have released their reference to this exact lock.
func (locks *sessionLocks) acquire(ctx context.Context, key string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	locks.mu.Lock()
	if locks.entries == nil {
		locks.entries = make(map[string]*sessionLock)
	}
	entry := locks.entries[key]
	if entry == nil {
		entry = &sessionLock{token: make(chan struct{}, 1)}
		locks.entries[key] = entry
	}
	entry.users++
	locks.mu.Unlock()
	releaseRef := func() {
		locks.mu.Lock()
		defer locks.mu.Unlock()
		entry.users--
		if entry.users == 0 {
			delete(locks.entries, key)
		}
	}
	select {
	case entry.token <- struct{}{}:
		return func() { <-entry.token; releaseRef() }, nil
	case <-ctx.Done():
		releaseRef()
		return nil, ctx.Err()
	}
}
