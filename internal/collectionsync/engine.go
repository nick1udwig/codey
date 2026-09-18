package collectionsync

import (
	"context"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"github.com/nick1udwig/pebble-agent/internal/collectionstore"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"strings"
	"sync"
	"sync/atomic"
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
	force     atomic.Bool
	now       func() time.Time
	pulls     map[string]*pullSchedule
}

type pullSchedule struct {
	binding  p.Binding
	next     time.Time
	interval time.Duration
}

func (p *pullSchedule) finish(now time.Time, changed bool) {
	if changed || p.interval == 0 {
		p.interval = time.Minute
	} else {
		p.interval = min(5*time.Minute, p.interval*2)
	}
	p.next = now.Add(p.interval)
	midnight := now.UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
	if midnight.Before(p.next) {
		p.next = midnight
	}
}

func New(s *collectionstore.Store, adapters map[string]p.Adapter, secrets Secrets) *Engine {
	return &Engine{Store: s, Adapters: adapters, Secrets: secrets, wake: make(chan struct{}, 1), owner: c.ID("worker_"), now: time.Now, pulls: make(map[string]*pullSchedule)}
}
func (e *Engine) Refresh() { e.force.Store(true); e.Wake() }

// Mutation uploads wake the worker without forcing unrelated provider scans.
func (e *Engine) Wake() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}
func (e *Engine) Run(ctx context.Context) {
	defer e.Store.Release(e.owner)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	e.force.Store(true)
	for {
		e.tick(ctx, e.force.Swap(false))
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-e.wake:
		}
	}
}
func (e *Engine) Tick(ctx context.Context) { e.tick(ctx, true) }
func (e *Engine) tick(ctx context.Context, force bool) {
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
	active := map[string]bool{}
	for _, b := range bindings {
		active[b.ID] = true
	}
	for id := range e.pulls {
		if !active[id] {
			delete(e.pulls, id)
		}
	}
	for _, b := range bindings {
		if b.State == "disconnected" {
			continue
		}
		a := e.Adapters[b.Provider]
		if a == nil {
			continue
		}
		identity := b
		identity.Checkpoint = ""
		identity.State = ""
		plan := e.pulls[b.ID]
		if plan == nil || plan.binding != identity {
			plan = &pullSchedule{binding: identity}
			e.pulls[b.ID] = plan
		}
		if !force && b.State == "auth_required" && e.now().Before(plan.next) {
			continue
		}
		creds, err := e.Secrets.Credentials(ctx, b)
		if err != nil {
			b.State = "auth_required"
			plan.finish(e.now(), false)
			e.Store.SaveBinding(b)
			continue
		}
		jobs, err := e.Store.Pending(b.ID)
		if err != nil {
			continue
		}
		deferredCreates := map[string]bool{}
		if creator, ok := a.(p.DeterministicCreator); ok {
			for _, j := range jobs {
				if strings.HasSuffix(j.Intent.Operation.Type, ".create") {
					if id, err := creator.CreateID(b, j.Intent.Record); err == nil {
						deferredCreates[id] = true
					}
				}
			}
		}
		blocked := map[string]bool{}
		wrote := false
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
			if e.now().Before(j.Intent.NextAttempt) {
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
			wrote = true
			j.Intent.Attempts++
			result, err := a.Apply(ctx, b, creds, j.ID, j.Intent, remote)
			if err != nil {
				result.State = p.State(err)
			}
			if result.State == "applied" && result.Remote != nil {
				if e.Store.Ack(j, *result.Remote) == nil {
					delete(deferredCreates, result.Remote.ID)
					blocked[j.RecordID] = false
				}
			} else {
				state := result.State
				if state == "retryable" {
					state = "pending"
					j.Intent.NextAttempt = e.now().Add(time.Duration(1<<min(j.Intent.Attempts, 10)) * time.Second)
				}
				if state == "" {
					state = "delivery_unknown"
				}
				e.Store.JobState(j, state)
			}
		}
		if !force && !wrote && e.now().Before(plan.next) {
			continue
		}
		var before, after int64
		beforeErr := e.Store.DB.QueryRow("SELECT COALESCE(MAX(sequence),0) FROM changes WHERE collection_id=?", b.CollectionID).Scan(&before)
		page := ""
		success := true
		checkpoint := b.Checkpoint
		seen := map[string]bool{}
		var windowStart, windowEnd time.Time
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
			windowStart, windowEnd = result.WindowStart, result.WindowEnd
			imports := make([]p.Remote, 0, len(result.Records))
			for _, r := range result.Records {
				seen[r.ID] = true
				if !deferredCreates[strings.SplitN(r.ID, "#", 2)[0]] {
					imports = append(imports, r)
				}
			}
			if err = e.Store.ImportBatch(b, imports); err != nil {
				success = false
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
			if err = e.Store.ReconcileMissingWindow(b, seen, windowStart, windowEnd); err != nil {
				success = false
			}
		}
		if success {
			b.Checkpoint = checkpoint
			b.State = "active"
		}
		afterErr := e.Store.DB.QueryRow("SELECT COALESCE(MAX(sequence),0) FROM changes WHERE collection_id=?", b.CollectionID).Scan(&after)
		plan.finish(e.now(), success && (beforeErr != nil || afterErr != nil || before != after))
		e.Store.SaveBinding(b)
	}
}
