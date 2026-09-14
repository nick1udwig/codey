package collectionstore

import (
	"database/sql"
	"encoding/json"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
)

func (s *Store) ResolveConflict(id, revision string, proposal bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = resolveConflict(tx, id, revision, proposal); e != nil {
		return e
	}
	return tx.Commit()
}
func resolveConflict(tx *sql.Tx, id, revision string, proposal bool) error {
	var e error
	var raw []byte
	if e = tx.QueryRow("SELECT data FROM conflicts WHERE id=?", id).Scan(&raw); e != nil {
		return c.Fail("not_found", "Conflict not found")
	}
	conf, e := Decode[c.Conflict](raw)
	if e != nil {
		return e
	}
	if conf.Resolved {
		return nil
	}
	var current *c.Record
	if e = tx.QueryRow("SELECT data FROM records WHERE id=?", conf.Operation.RecordID).Scan(&raw); e == nil {
		v, e := Decode[c.Record](raw)
		if e != nil {
			return e
		}
		current = &v
		if v.Revision != revision {
			return c.Fail("stale_revision", "Record changed; inspect the new revision")
		}
	} else if revision != "0" {
		return c.Fail("stale_revision", "Record no longer exists")
	}
	if conf.Operation.Type == "provider.import" {
		if current == nil {
			return c.Fail("not_found", "Canonical record unavailable")
		}
		var remote p.Remote
		var bindingID string
		if e = json.Unmarshal(conf.Operation.Payload["remote"], &remote); e != nil {
			return e
		}
		if e = json.Unmarshal(conf.Operation.Payload["binding_id"], &bindingID); e != nil {
			return e
		}
		if e = resolveProvider(tx, bindingID, *current, remote, proposal); e != nil {
			return e
		}
		conf.Resolved = true
		if _, e = tx.Exec("UPDATE conflicts SET data=? WHERE id=?", encode(conf), conf.ID); e != nil {
			return e
		}
		return nil
	}
	if proposal {

		var col c.Collection
		if e = tx.QueryRow("SELECT data FROM collections WHERE id=?", conf.Operation.CollectionID).Scan(&raw); e != nil {
			return e
		}
		if e = json.Unmarshal(raw, &col); e != nil {
			return e
		}
		op := conf.Operation
		op.BaseRevision = revision
		next, e := c.Apply(current, op, col.Kind)
		if e != nil {
			return e
		}
		if col.BindingID != "" {
			next.ProviderState = "pending"
		}
		if _, e = tx.Exec("INSERT INTO records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", next.ID, col.ID, encode(next)); e != nil {
			return e
		}
		if _, e = tx.Exec("INSERT INTO versions VALUES(?,?,?)", next.ID, next.Revision, encode(next)); e != nil {
			return e
		}
		if _, e = tx.Exec("INSERT INTO changes(collection_id,data) VALUES(?,?)", col.ID, encode(next.Summary())); e != nil {
			return e
		}
		if col.BindingID != "" {
			if _, e = tx.Exec("INSERT INTO provider_jobs VALUES(?,?,?,?,?,?)", c.ID("push_"), col.BindingID, next.ID, next.Revision, "pending", encode(p.Intent{Record: next, Operation: op, Base: current})); e != nil {
				return e
			}
		}
	}
	conf.Resolved = true
	if _, e = tx.Exec("UPDATE conflicts SET data=? WHERE id=?", encode(conf), conf.ID); e != nil {
		return e
	}
	return nil
}

// An explicit, revision-checked decision either adopts the remote proposal or
// rebases a full local write on that observed remote version. Older outbound
// intents remain stored as stopped history.
func resolveProvider(tx *sql.Tx, binding string, current c.Record, remote p.Remote, adopt bool) error {
	var uncertain int
	if e := tx.QueryRow("SELECT count(*) FROM provider_jobs WHERE binding_id=? AND record_id=? AND state IN ('in_flight','delivery_unknown','in_progress')", binding, current.ID).Scan(&uncertain); e != nil {
		return e
	}
	if uncertain > 0 {
		return c.Fail("binding_changed", "Resolve uncertain delivery first")
	}
	if _, e := tx.Exec("UPDATE provider_jobs SET state='stopped' WHERE binding_id=? AND record_id=? AND state!='applied'", binding, current.ID); e != nil {
		return e
	}
	next := current
	if adopt {
		next = remote.Record
		next.ID = current.ID
		next.CollectionID = current.CollectionID
		next.CreatedAt = current.CreatedAt
		next.Revision = c.Next(current.Revision)
		next.UpdatedAt = c.Now()
		next.BodyHash = c.Hash(next.Body)
		next.ProviderState = "synced"
		if _, e := tx.Exec("INSERT INTO versions VALUES(?,?,?)", next.ID, next.Revision, encode(next)); e != nil {
			return e
		}
	} else {
		next.ProviderState = "pending"
		op := c.Operation{CollectionID: current.CollectionID, RecordID: current.ID, Payload: map[string]json.RawMessage{}}
		if current.Deleted {
			op.Type = "record.delete"
		} else if current.Kind == "note" {
			if remote.Record.Deleted || !remote.Record.BodyComplete {
				return c.Fail("permission_denied", "Cannot replace deleted or incomplete remote content")
			}
			op.Type = "note.replace"
			op.Payload = map[string]json.RawMessage{"body": p.Raw(current.Body), "whole_note": p.Raw(true)}
		} else {
			if remote.Record.Deleted {
				return c.Fail("permission_denied", "Cannot overwrite a deleted remote task")
			}
			op.Type = "task.patch"
			op.Payload = map[string]json.RawMessage{"title": p.Raw(current.Title), "description": p.Raw(current.Description), "due": p.Raw(current.Due)}
		}
		if _, e := tx.Exec("INSERT INTO provider_jobs VALUES(?,?,?,?,?,?)", c.ID("push_"), binding, current.ID, current.Revision, "pending", encode(p.Intent{Record: current, Operation: op, Base: &remote.Record})); e != nil {
			return e
		}
		if current.Kind == "task" && !current.Deleted && current.Completed != remote.Record.Completed {
			op.Type = "task.restore"
			if current.Completed {
				op.Type = "task.complete"
			}
			op.Payload = map[string]json.RawMessage{}
			if _, e := tx.Exec("INSERT INTO provider_jobs VALUES(?,?,?,?,?,?)", c.ID("push_"), binding, current.ID, current.Revision, "pending", encode(p.Intent{Record: current, Operation: op, Base: &remote.Record})); e != nil {
				return e
			}
		}
	}
	if _, e := tx.Exec("UPDATE records SET data=? WHERE id=?", encode(next), next.ID); e != nil {
		return e
	}
	if _, e := tx.Exec("INSERT INTO changes(collection_id,data) VALUES(?,?)", next.CollectionID, encode(next.Summary())); e != nil {
		return e
	}
	_, e := tx.Exec("UPDATE mappings SET data=? WHERE binding_id=? AND remote_id=?", encode(Mapping{Remote: remote, LocalRevision: next.Revision}), binding, remote.ID)
	return e
}

// PreserveRecovery transfers ownership of quarantined input without executing it.
// In particular, creates from a rolled-back store are never blindly replayed.
func (s *Store) PreserveRecovery(batch c.Batch) ([]c.Result, error) {
	if batch.ServerID != s.ServerID {
		return nil, c.Fail("server_mismatch", "Recovery must use the original server")
	}
	if len(batch.Operations) > 256 {
		return nil, c.Fail("invalid_input", "Recovery batch too large")
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	out := []c.Result{}
	for _, op := range batch.Operations {
		if e = c.ValidateIdentity(batch.ClientID, op); e != nil {
			return nil, e
		}
		id := "recovery_" + c.Hash([]any{batch.ServerID, batch.Epoch, batch.ClientID, op})
		conf := c.Conflict{ID: id, Operation: op, Cause: "recovery_required"}
		if _, e = tx.Exec("INSERT OR IGNORE INTO conflicts VALUES(?,?)", id, encode(conf)); e != nil {
			return nil, e
		}
		out = append(out, c.Result{OperationID: op.ID, RecordID: op.RecordID, Outcome: "conflict", Durable: true, ConflictID: id, Code: "recovery_required"})
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return out, nil
}
func (s *Store) ResumeProviders() error {
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var n int
	if e = tx.QueryRow("SELECT count(*) FROM provider_jobs WHERE state IN ('recovery_required','delivery_unknown','in_progress','in_flight')").Scan(&n); e != nil {
		return e
	}
	if n != 0 {
		return c.Fail("binding_changed", "Resolve all uncertain provider operations before resuming")
	}
	if _, e = tx.Exec("UPDATE metadata SET value='false' WHERE key='provider_paused'"); e != nil {
		return e
	}
	return tx.Commit()
}
