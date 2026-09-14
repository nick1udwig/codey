package collectionstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"time"
)

type Job struct {
	ID        string
	BindingID string
	RecordID  string
	Revision  string
	State     string
	Intent    p.Intent
}
type Mapping struct {
	Remote        p.Remote `json:"remote"`
	LocalRevision string   `json:"local_revision"`
}

func (s *Store) Bindings() ([]p.Binding, error) {
	rows, e := s.DB.Query("SELECT data FROM bindings")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []p.Binding{}
	for rows.Next() {
		var b []byte
		if e = rows.Scan(&b); e != nil {
			return nil, e
		}
		v, e := Decode[p.Binding](b)
		if e != nil {
			return nil, e
		}
		v.SecretID = v.ID
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) SaveBinding(b p.Binding) error {
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var raw []byte
	if e = tx.QueryRow("SELECT data FROM bindings WHERE id=?", b.ID).Scan(&raw); e != nil {
		return e
	}
	current, e := Decode[p.Binding](raw)
	if e != nil {
		return e
	}
	if current.State == "disconnected" {
		return nil
	}
	if _, e = tx.Exec("UPDATE bindings SET data=? WHERE id=?", encode(b), b.ID); e != nil {
		return e
	}
	return tx.Commit()
}

func (s *Store) Bind(binding p.Binding, generation string, export bool, stopPending bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var raw []byte
	if e = tx.QueryRow("SELECT data FROM collections WHERE id=?", binding.CollectionID).Scan(&raw); e != nil {
		return e
	}
	col, e := Decode[c.Collection](raw)
	if e != nil {
		return e
	}
	if col.Generation != generation {
		return c.Fail("binding_changed", "Binding preview is stale")
	}
	var inFlight int
	if e = tx.QueryRow("SELECT count(*) FROM provider_jobs WHERE binding_id=? AND state IN ('in_flight','delivery_unknown','in_progress','recovery_required')", col.BindingID).Scan(&inFlight); e != nil {
		return e
	}
	if inFlight > 0 {
		return c.Fail("binding_changed", "Resolve uncertain/in-flight delivery before switching")
	}
	var pending int
	if e = tx.QueryRow("SELECT count(*) FROM provider_jobs WHERE binding_id=? AND state='pending'", col.BindingID).Scan(&pending); e != nil {
		return e
	}
	if pending > 0 && !stopPending {
		return c.Fail("binding_changed", "Finish pending work or explicitly stop old delivery")
	}
	if _, e = tx.Exec("UPDATE provider_jobs SET state='stopped' WHERE binding_id=? AND state='pending'", col.BindingID); e != nil {
		return e
	}
	if col.BindingID != "" {
		var oldraw []byte
		if e = tx.QueryRow("SELECT data FROM bindings WHERE id=?", col.BindingID).Scan(&oldraw); e != nil {
			return e
		}
		old, e := Decode[p.Binding](oldraw)
		if e != nil {
			return e
		}
		old.State = "disconnected"
		if _, e = tx.Exec("UPDATE bindings SET data=? WHERE id=?", encode(old), old.ID); e != nil {
			return e
		}
	}
	col.Generation = c.Next(col.Generation)
	col.BindingID = binding.ID
	if binding.Provider == "" {
		col.BindingID = ""
	} else {
		binding.Generation = col.Generation
		binding.State = "active"
		if _, e = tx.Exec("INSERT INTO bindings VALUES(?,?,?)", binding.ID, col.ID, encode(binding)); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("UPDATE collections SET data=? WHERE id=?", encode(col), col.ID); e != nil {
		return e
	}
	if export && col.BindingID != "" {
		rows, e := tx.Query("SELECT data FROM records WHERE collection_id=?", col.ID)
		if e != nil {
			return e
		}
		records := []c.Record{}
		for rows.Next() {
			var raw []byte
			if e = rows.Scan(&raw); e != nil {
				rows.Close()
				return e
			}
			r, e := Decode[c.Record](raw)
			if e != nil {
				rows.Close()
				return e
			}
			if !r.Deleted {
				records = append(records, r)
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, r := range records {
			in := p.Intent{Record: r, Operation: c.Operation{Type: r.Kind + ".create", RecordID: r.ID, CollectionID: r.CollectionID, Payload: map[string]json.RawMessage{}}}
			if _, e = tx.Exec("INSERT INTO provider_jobs VALUES(?,?,?,?,?,?)", c.ID("push_"), binding.ID, r.ID, r.Revision, "pending", encode(in)); e != nil {
				return e
			}
		}
	}
	return tx.Commit()
}
func (s *Store) Mapping(binding, record string) (*Mapping, error) {
	var raw []byte
	e := s.DB.QueryRow("SELECT data FROM mappings WHERE binding_id=? AND record_id=?", binding, record).Scan(&raw)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	m, e := Decode[Mapping](raw)
	return &m, e
}
func (s *Store) Pending(binding string) ([]Job, error) {
	rows, e := s.DB.Query("SELECT id,record_id,revision,state,data FROM provider_jobs WHERE binding_id=? AND state NOT IN ('applied','stopped') ORDER BY rowid", binding)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Job{}
	for rows.Next() {
		j := Job{BindingID: binding}
		var raw []byte
		if e = rows.Scan(&j.ID, &j.RecordID, &j.Revision, &j.State, &raw); e != nil {
			return nil, e
		}
		j.Intent, e = Decode[p.Intent](raw)
		if e != nil {
			return nil, e
		}
		out = append(out, j)
	}
	return out, rows.Err()
}
func (s *Store) JobState(j Job, state string) error {
	_, e := s.DB.Exec("UPDATE provider_jobs SET state=?,data=? WHERE id=?", state, encode(j.Intent), j.ID)
	return e
}
func (s *Store) RecoverJobs() error {
	_, e := s.DB.Exec("UPDATE provider_jobs SET state='delivery_unknown' WHERE state='in_flight'")
	return e
}
func (s *Store) Ack(j Job, remote p.Remote) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var mappedRecord string
	lookup := tx.QueryRow("SELECT record_id FROM mappings WHERE binding_id=? AND remote_id=?", j.BindingID, remote.ID).Scan(&mappedRecord)
	if lookup == nil && mappedRecord != j.RecordID {
		return c.Fail("idempotency_mismatch", "Remote identity already maps to another record")
	}
	if lookup != nil && !errors.Is(lookup, sql.ErrNoRows) {
		return lookup
	}
	var raw []byte
	if e = tx.QueryRow("SELECT data FROM records WHERE id=?", j.RecordID).Scan(&raw); e != nil {
		return e
	}
	r, e := Decode[c.Record](raw)
	if e != nil {
		return e
	}
	m := Mapping{Remote: remote, LocalRevision: j.Revision}
	var following int
	if e = tx.QueryRow("SELECT count(*) FROM provider_jobs WHERE binding_id=? AND record_id=? AND id!=? AND state NOT IN ('applied','stopped')", j.BindingID, j.RecordID, j.ID).Scan(&following); e != nil {
		return e
	}
	if r.Revision == j.Revision && following == 0 {
		if contentHash(r) != contentHash(remote.Record) {
			next := remote.Record
			next.ID = r.ID
			next.CollectionID = r.CollectionID
			next.Revision = c.Next(r.Revision)
			next.CreatedAt = r.CreatedAt
			next.UpdatedAt = c.Now()
			next.BodyHash = c.Hash(next.Body)
			r = next
			if _, e = tx.Exec("INSERT INTO versions VALUES(?,?,?)", r.ID, r.Revision, encode(r)); e != nil {
				return e
			}
		}
		r.ProviderState = "synced"
		m.LocalRevision = r.Revision
		if _, e = tx.Exec("UPDATE records SET data=? WHERE id=?", encode(r), r.ID); e != nil {
			return e
		}
		if _, e = tx.Exec("INSERT INTO changes(collection_id,data) VALUES(?,?)", r.CollectionID, encode(r.Summary())); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("INSERT INTO mappings VALUES(?,?,?,?) ON CONFLICT(binding_id,remote_id) DO UPDATE SET data=excluded.data", j.BindingID, remote.ID, j.RecordID, encode(m)); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE provider_jobs SET state='applied' WHERE id=?", j.ID); e != nil {
		return e
	}
	return tx.Commit()
}
func contentHash(r c.Record) string {
	return c.Hash([]any{r.Title, r.Body, r.Description, r.Completed, r.CompletedAt, r.Deleted, r.Due, r.Format, r.BodyComplete})
}

// Import writes a canonical revision before advancing any provider checkpoint.
func (s *Store) Import(binding p.Binding, remote p.Remote) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var collectionData []byte
	if e = tx.QueryRow("SELECT data FROM collections WHERE id=?", binding.CollectionID).Scan(&collectionData); e != nil {
		return e
	}
	active, e := Decode[c.Collection](collectionData)
	if e != nil {
		return e
	}
	if active.BindingID != binding.ID {
		return nil
	}
	var raw []byte
	var id string
	e = tx.QueryRow("SELECT record_id,data FROM mappings WHERE binding_id=? AND remote_id=?", binding.ID, remote.ID).Scan(&id, &raw)
	var old *c.Record
	var mapping Mapping
	if e == nil {
		mapping, e = Decode[Mapping](raw)
		if e != nil {
			return e
		}
		if mapping.Remote.Version == remote.Version && c.Hash(mapping.Remote.Record) == c.Hash(remote.Record) {
			return nil
		}
		if e = tx.QueryRow("SELECT data FROM records WHERE id=?", id).Scan(&raw); e != nil {
			return e
		}
		r, e := Decode[c.Record](raw)
		if e != nil {
			return e
		}
		old = &r
		var pending int
		if e = tx.QueryRow("SELECT count(*) FROM provider_jobs WHERE binding_id=? AND record_id=? AND state NOT IN ('applied','stopped')", binding.ID, id).Scan(&pending); e != nil {
			return e
		}
		if pending > 0 || old.Revision != mapping.LocalRevision {
			conf := c.Conflict{ID: "provider_" + c.Hash([]string{binding.ID, id, remote.Version}), Current: old, Cause: "provider_concurrent_edit", Operation: c.Operation{RecordID: id, CollectionID: binding.CollectionID, Type: "provider.import", Payload: map[string]json.RawMessage{"remote": p.Raw(remote), "binding_id": p.Raw(binding.ID)}}}
			if _, e = tx.Exec("INSERT OR IGNORE INTO conflicts VALUES(?,?)", conf.ID, encode(conf)); e != nil {
				return e
			}
			return tx.Commit()
		}
	} else if !errors.Is(e, sql.ErrNoRows) {
		return e
	}
	if remote.Container != binding.Container {
		return nil
	}
	if old == nil && remote.Record.Deleted {
		return nil
	}
	r := remote.Record
	r.CollectionID = binding.CollectionID
	r.ID = id
	r.Revision = "1"
	r.CreatedAt = c.Now()
	if old != nil {
		r.Revision = c.Next(old.Revision)
		r.CreatedAt = old.CreatedAt
	} else {
		r.ID = c.ID("rec_server_")
	}
	r.UpdatedAt = c.Now()
	r.ProviderState = "synced"
	r.BodyHash = c.Hash(r.Body)
	if _, e = tx.Exec("INSERT INTO records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", r.ID, r.CollectionID, encode(r)); e != nil {
		return e
	}
	if _, e = tx.Exec("INSERT INTO versions VALUES(?,?,?)", r.ID, r.Revision, encode(r)); e != nil {
		return e
	}
	if _, e = tx.Exec("INSERT INTO changes(collection_id,data) VALUES(?,?)", r.CollectionID, encode(r.Summary())); e != nil {
		return e
	}
	mapping = Mapping{Remote: remote, LocalRevision: r.Revision}
	if _, e = tx.Exec("INSERT INTO mappings VALUES(?,?,?,?) ON CONFLICT(binding_id,remote_id) DO UPDATE SET data=excluded.data", binding.ID, remote.ID, r.ID, encode(mapping)); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) Lease(owner string) (bool, error) {
	_, e := s.DB.Exec("CREATE TABLE IF NOT EXISTS worker_lease(id INTEGER PRIMARY KEY,owner TEXT,expires INTEGER)")
	if e != nil {
		return false, e
	}
	r, e := s.DB.Exec("INSERT INTO worker_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE worker_lease.expires<? OR worker_lease.owner=?", owner, time.Now().Add(2*time.Minute).Unix(), time.Now().Unix(), owner)
	if e != nil {
		return false, e
	}
	n, e := r.RowsAffected()
	return n == 1, e
}
func (s *Store) Release(owner string) { s.DB.Exec("DELETE FROM worker_lease WHERE owner=?", owner) }

func (s *Store) ClaimJob(j Job) error {
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var raw []byte
	if e = tx.QueryRow("SELECT data FROM collections WHERE id=?", j.Intent.Record.CollectionID).Scan(&raw); e != nil {
		return e
	}
	col, e := Decode[c.Collection](raw)
	if e != nil {
		return e
	}
	if col.BindingID != j.BindingID {
		return c.Fail("binding_changed", "Provider binding changed")
	}
	r, e := tx.Exec("UPDATE provider_jobs SET state='in_flight' WHERE id=? AND state IN ('pending','delivery_unknown')", j.ID)
	if e != nil {
		return e
	}
	n, e := r.RowsAffected()
	if e != nil {
		return e
	}
	if n != 1 {
		return c.Fail("binding_changed", "Provider job changed")
	}
	return tx.Commit()
}
func (s *Store) ReconcileMissing(binding p.Binding, seen map[string]bool) error {
	rows, e := s.DB.Query("SELECT data FROM mappings WHERE binding_id=?", binding.ID)
	if e != nil {
		return e
	}
	missing := []p.Remote{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			rows.Close()
			return e
		}
		m, e := Decode[Mapping](raw)
		if e != nil {
			rows.Close()
			return e
		}
		if !seen[m.Remote.ID] && !m.Remote.Record.Deleted {
			r := m.Remote
			r.Record.Deleted = true
			r.Version = "deleted:" + r.Version
			missing = append(missing, r)
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, r := range missing {
		if e = s.Import(binding, r); e != nil {
			return e
		}
	}
	return nil
}
