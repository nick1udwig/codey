package collectionsync

import (
	"context"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"github.com/nick1udwig/pebble-agent/internal/collectionstore"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"sync"
	"time"
)

type Secrets interface {
	Credentials(context.Context, p.Binding) (p.Credentials, error)
}
type Engine struct {
	Store     *collectionstore.Store
	Adapters  map[string]p.Adapter
	Secrets   Secrets
	wake      chan struct{}
	mu        sync.Mutex
	owner     string
	recovered bool
}

func New(s *collectionstore.Store, adapters map[string]p.Adapter, secrets Secrets) *Engine {
	return &Engine{Store: s, Adapters: adapters, Secrets: secrets, wake: make(chan struct{}, 1), owner: c.ID("worker_")}
}
func (e *Engine) Refresh() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}
func (e *Engine) Run(ctx context.Context) {
	defer e.Store.Release(e.owner)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		e.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-e.wake:
		}
	}
}
func (e *Engine) Tick(ctx context.Context) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var paused string
	if e.Store.DB.QueryRow("SELECT value FROM metadata WHERE key='provider_paused'").Scan(&paused) == nil && paused == "true" {
		return
	}
	ok, err := e.Store.Lease(e.owner)
	if err != nil || !ok {
		return
	}
	if !e.recovered {
		if err = e.Store.RecoverJobs(); err != nil {
			return
		}
		e.recovered = true
	}
	bindings, err := e.Store.Bindings()
	if err != nil {
		return
	}
	for _, b := range bindings {
		if b.State == "disconnected" {
			continue
		}
		a := e.Adapters[b.Provider]
		if a == nil {
			continue
		}
		creds, err := e.Secrets.Credentials(ctx, b)
		if err != nil {
			b.State = "auth_required"
			e.Store.SaveBinding(b)
			continue
		}
		jobs, err := e.Store.Pending(b.ID)
		if err != nil {
			continue
		}
		blocked := map[string]bool{}
		for _, j := range jobs {
			if ctx.Err() != nil {
				return
			}
			if ok, err = e.Store.Lease(e.owner); err != nil || !ok {
				return
			}
			if blocked[j.RecordID] {
				continue
			}
			blocked[j.RecordID] = true
			if j.State != "pending" && !(j.State == "delivery_unknown" && a.Describe().IdempotentWrites) {
				continue
			}
			if time.Now().Before(j.Intent.NextAttempt) {
				continue
			}
			mapping, err := e.Store.Mapping(b.ID, j.RecordID)
			if err != nil {
				continue
			}
			var remote *p.Remote
			if mapping != nil {
				remote = &mapping.Remote
				current, fetchErr := a.Fetch(ctx, b, creds, remote.ID)
				if fetchErr != nil {
					if p.State(fetchErr) == "not_found" && j.Intent.Record.Deleted {
						remote.Record.Deleted = true
						e.Store.Ack(j, *remote)
						blocked[j.RecordID] = false
					}
					continue
				}
				if current.Container != b.Container {
					e.Store.JobState(j, "scope_removed")
					continue
				}
				if j.State != "delivery_unknown" && remote.Version != "" && current.Version != remote.Version {
					e.Store.JobState(j, "conflict")
					e.Store.Import(b, current)
					continue
				}
				remote = &current
			}
			if err = e.Store.ClaimJob(j); err != nil {
				continue
			}
			j.Intent.Attempts++
			result, err := a.Apply(ctx, b, creds, j.ID, j.Intent, remote)
			if err != nil {
				result.State = p.State(err)
			}
			if result.State == "applied" && result.Remote != nil {
				if e.Store.Ack(j, *result.Remote) == nil {
					blocked[j.RecordID] = false
				}
			} else {
				state := result.State
				if state == "retryable" {
					state = "pending"
					j.Intent.NextAttempt = time.Now().Add(time.Duration(1<<min(j.Intent.Attempts, 10)) * time.Second)
				}
				if state == "" {
					state = "delivery_unknown"
				}
				e.Store.JobState(j, state)
			}
		}
		page := ""
		success := true
		checkpoint := b.Checkpoint
		seen := map[string]bool{}
		for pages := 0; pages < 10000; pages++ {
			if ctx.Err() != nil {
				return
			}
			if ok, err = e.Store.Lease(e.owner); err != nil || !ok {
				return
			}
			result, err := a.Pull(ctx, b, creds, page)
			if err != nil {
				b.State = p.State(err)
				success = false
				break
			}
			for _, r := range result.Records {
				seen[r.ID] = true
				if err = e.Store.Import(b, r); err != nil {
					success = false
					break
				}
			}
			if !success {
				break
			}
			if result.Checkpoint != "" {
				checkpoint = result.Checkpoint
			}
			if result.Next == "" {
				break
			}
			if result.Next == page {
				success = false
				break
			}
			page = result.Next
			if pages == 9999 {
				success = false
			}
		}
		if success && a.Describe().AbsenceDeletion {
			if err = e.Store.ReconcileMissing(b, seen); err != nil {
				success = false
			}
		}
		if success {
			b.Checkpoint = checkpoint
			b.State = "active"
		}
		e.Store.SaveBinding(b)
	}
}
