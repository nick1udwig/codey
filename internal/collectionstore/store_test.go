package collectionstore

import (
	"encoding/json"
	"errors"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"path/filepath"
	"testing"
)

func field(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func fixture(t *testing.T) (*Store, c.Batch) {
	t.Helper()
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	id, e := s.Enroll()
	if e != nil {
		t.Fatal(e)
	}
	op := c.Operation{ID: "op:" + id + ":1", Sequence: "1", IngressID: "watch:session:1", CollectionID: "col_note", Generation: "1", RecordID: "rec:" + id + ":1", Type: "note.create", Payload: map[string]json.RawMessage{"title": field("Note"), "body": field("hello 🌍")}}
	return s, c.Batch{Version: 1, ServerID: s.ServerID, Epoch: s.Epoch, ClientID: id, Operations: []c.Operation{op}}
}
func TestLostResponseAndAtomicRollback(t *testing.T) {
	for _, point := range []string{"mutation.before_commit", "mutation.after_commit"} {
		t.Run(point, func(t *testing.T) {
			s, b := fixture(t)
			s.Fault = func(p string) error {
				if p == point {
					return errors.New("power loss")
				}
				return nil
			}
			if _, e := s.Mutate(b); e == nil {
				t.Fatal("fault missed")
			}
			s.Fault = nil
			r, e := s.Mutate(b)
			if e != nil || r[0].Outcome != "applied" {
				t.Fatalf("%+v %v", r, e)
			}
			var n int
			s.DB.QueryRow("SELECT count(*) FROM records").Scan(&n)
			if n != 1 {
				t.Fatal(n)
			}
			if r[0].Duplicate != (point == "mutation.after_commit") {
				t.Fatal(r)
			}
			s.DB.QueryRow("SELECT count(*) FROM changes").Scan(&n)
			if n != 1 {
				t.Fatal(n)
			}
		})
	}
}
func TestReplayMismatchAndConflictRetainsProposal(t *testing.T) {
	s, b := fixture(t)
	if _, e := s.Mutate(b); e != nil {
		t.Fatal(e)
	}
	b.Operations[0].Payload["body"] = field("different")
	if _, e := s.Mutate(b); ErrorCode(e) != "idempotency_mismatch" {
		t.Fatal(e)
	}
	op := b.Operations[0]
	op.ID = "op:" + b.ClientID + ":2"
	op.Sequence = "2"
	op.IngressID = "watch:session:2"
	op.Type = "note.replace"
	op.BaseRevision = "0"
	op.Payload = map[string]json.RawMessage{"body": field("preserve me"), "whole_note": field(true)}
	b.Operations = []c.Operation{op}
	r, e := s.Mutate(b)
	if e != nil || r[0].Outcome != "conflict" || !r[0].Durable {
		t.Fatalf("%+v %v", r, e)
	}
	conflicts, e := s.Conflicts()
	if e != nil || len(conflicts) != 1 || string(conflicts[0].Operation.Payload["body"]) != `"preserve me"` {
		t.Fatalf("%+v %v", conflicts, e)
	}
}
func TestDependentMutationReplay(t *testing.T) {
	s, b := fixture(t)
	first := b.Operations[0]
	if _, e := s.Mutate(b); e != nil {
		t.Fatal(e)
	}
	op := first
	op.ID = "op:" + b.ClientID + ":2"
	op.Sequence = "2"
	op.IngressID = "watch:session:2"
	op.Type = "note.append"
	op.BaseOperationID = first.ID
	op.Payload = map[string]json.RawMessage{"text": field(" appended")}
	b.Operations = []c.Operation{op}
	for i := 0; i < 2; i++ {
		r, e := s.Mutate(b)
		if e != nil || r[0].Revision != "2" {
			t.Fatalf("%+v %v", r, e)
		}
	}
}
func TestSnapshotAndPinnedUTF8Body(t *testing.T) {
	s, b := fixture(t)
	s.Mutate(b)
	snap, e := s.Snapshot("col_note", "all")
	if e != nil {
		t.Fatal(e)
	}
	op := b.Operations[0]
	op.ID = "op:" + b.ClientID + ":2"
	op.Sequence = "2"
	op.IngressID = "watch:session:2"
	op.Type = "note.append"
	op.BaseRevision = "1"
	op.Payload = map[string]json.RawMessage{"text": field(" new")}
	b.Operations = []c.Operation{op}
	if _, e = s.Mutate(b); e != nil {
		t.Fatal(e)
	}
	page, e := s.SnapshotPage(snap.SnapshotID, "", 1)
	if e != nil || page.Records[0].Revision != "1" {
		t.Fatal(page, e)
	}
	changes, e := s.Changes("col_note", snap.Cursor, 100)
	if e != nil || len(changes["changes"].([]c.Change)) != 1 {
		t.Fatal(changes, e)
	}
	body := ""
	cursor := ""
	for {
		p, e := s.Body(op.RecordID, "1", cursor, 4)
		if e != nil {
			t.Fatal(e)
		}
		body += p["body"].(string)
		cursor = p["next_cursor"].(string)
		if cursor == "" {
			break
		}
	}
	if body != "hello 🌍" {
		t.Fatal(body)
	}
	if _, e = s.Changes("col_task", snap.Cursor, 100); e == nil {
		t.Fatal("cross-collection cursor accepted")
	}
}
func TestRestartBackupRestoreEpoch(t *testing.T) {
	s, b := fixture(t)
	s.Mutate(b)
	backup := filepath.Join(t.TempDir(), "collections.db")
	if e := s.Backup(backup); e != nil {
		t.Fatal(e)
	}
	restored, e := Open(filepath.Dir(backup))
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	if _, e = restored.Receipt(b.Operations[0].ID, false); e != nil {
		t.Fatal(e)
	}
	if e = restored.RestoreEpoch(); e != nil {
		t.Fatal(e)
	}
	if _, e = restored.Mutate(b); ErrorCode(e) != "store_epoch_changed" {
		t.Fatal(e)
	}
}
