package agent

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSessionLocksChurnAndConcurrency(t *testing.T) {
	var locks sessionLocks
	var active [20]atomic.Int32
	var overlap atomic.Bool
	var wg sync.WaitGroup
	for i := 0; i < 2000; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := i % len(active)
			release, err := locks.acquire(context.Background(), fmt.Sprint(key))
			if err != nil {
				t.Error(err)
				return
			}
			if active[key].Add(1) != 1 {
				overlap.Store(true)
			}
			active[key].Add(-1)
			release()
		}(i)
	}
	wg.Wait()
	for i := 0; i < 5000; i++ {
		release, err := locks.acquire(context.Background(), fmt.Sprint("finished-", i))
		if err != nil {
			t.Fatal(err)
		}
		release()
	}
	if overlap.Load() {
		t.Fatal("same-session turns overlapped")
	}
	if len(locks.entries) != 0 {
		t.Fatal("completed sessions retained", len(locks.entries))
	}
	// A held session must not serialize an unrelated one.
	release, _ := locks.acquire(context.Background(), "held")
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	other, err := locks.acquire(ctx, "other")
	if err != nil {
		t.Fatal(err)
	}
	other()
}

func TestSessionLocksCanceledWaiters(t *testing.T) {
	var locks sessionLocks
	release, _ := locks.acquire(context.Background(), "same")
	var wg sync.WaitGroup
	ctx, cancel := context.WithCancel(context.Background())
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unlock, err := locks.acquire(ctx, "same")
			if err == nil {
				unlock()
				t.Error("canceled waiter acquired held lock")
			}
		}()
	}
	deadline := time.Now().Add(time.Second)
	for {
		locks.mu.Lock()
		users := locks.entries["same"].users
		locks.mu.Unlock()
		if users == 101 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("waiters did not start")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	wg.Wait()
	locks.mu.Lock()
	users := locks.entries["same"].users
	locks.mu.Unlock()
	if users != 1 {
		t.Fatal(users)
	}
	release()
	if len(locks.entries) != 0 {
		t.Fatal("canceled references leaked")
	}
}

func TestLoadedThreadsFollowConnectionGeneration(t *testing.T) {
	agent := New(nil, nil, Config{})
	for generation := uint64(1); generation <= 100; generation++ {
		for i := 0; i < 100; i++ {
			agent.markLoaded(fmt.Sprintf("%d-%d", generation, i), generation)
		}
		if len(agent.loaded) != 100 {
			t.Fatal("old generation retained", len(agent.loaded))
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			agent.markLoaded("late", 99)
			if agent.isLoaded("late", 99) {
				t.Error("old generation loaded")
			}
		}()
	}
	wg.Wait()
	if !agent.isLoaded("100-0", 100) || len(agent.loaded) != 100 {
		t.Fatal("late reply displaced current generation")
	}
	if agent.isLoaded("missing", 101) || len(agent.loaded) != 0 {
		t.Fatal("reconnect failed to clear old state")
	}
}
