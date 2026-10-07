package collectionstore

import (
	"encoding/json"
	"fmt"
	"testing"

	c "github.com/nick1udwig/pebble-agent/internal/collections"
)

func checkOperation(client string, n int, name, typ, record string, payload map[string]json.RawMessage) c.Operation {
	seq := fmt.Sprint(n)
	if record == "" {
		record = "rec:" + client + ":" + seq
	}
	return c.Operation{ID: "op:" + client + ":" + seq, IngressID: "watch:checks:" + seq, Sequence: seq, CollectionID: "col_check", Generation: "1", RecordID: record, Type: typ, Payload: payload}
}

func TestChecksCreateRepeatReplayAndHistory(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	client, err := s.Enroll()
	if err != nil {
		t.Fatal(err)
	}
	batch := c.Batch{Version: 1, ServerID: s.ServerID, Epoch: s.Epoch, ClientID: client}
	var baby string
	for i, name := range []string{"baby", "baby sleep", "baby wake"} {
		op := checkOperation(client, i+1, name, "check.create", "", map[string]json.RawMessage{"title": field(name)})
		batch.Operations = []c.Operation{op}
		result, e := s.Mutate(batch)
		if e != nil || result[0].Outcome != "applied" || result[0].Record.Count != 0 {
			t.Fatalf("create %s: %+v %v", name, result, e)
		}
		if i == 0 {
			baby = op.RecordID
		}
	}
	for _, name := range []string{" BABY ", "BaBy SlEeP", "baby wake"} {
		record, e := s.CheckByName(name)
		if e != nil || record.Title == "" || record.Count != 0 {
			t.Fatalf("lookup %q: %+v %v", name, record, e)
		}
	}
	duplicate := checkOperation(client, 4, "", "check.create", "", map[string]json.RawMessage{"title": field("  BABY  ")})
	batch.Operations = []c.Operation{duplicate}
	result, e := s.Mutate(batch)
	if e != nil || result[0].Outcome != "applied" || result[0].Code != "already_exists" || !result[0].Durable || result[0].Record.ID != baby {
		t.Fatalf("duplicate: %+v %v", result, e)
	}
	result, e = s.Mutate(batch)
	if e != nil || !result[0].Duplicate {
		t.Fatalf("duplicate replay: %+v %v", result, e)
	}
	aliased := checkOperation(client, 17, "", "check.add", duplicate.RecordID, map[string]json.RawMessage{"occurred_at": field("2026-09-27T12:00:00Z")})
	aliased.BaseOperationID = duplicate.ID
	batch.Operations = []c.Operation{aliased}
	result, e = s.Mutate(batch)
	if e != nil || result[0].Outcome != "applied" || result[0].Record.ID != baby || result[0].Record.Count != 1 {
		t.Fatalf("aliased add: %+v %v", result, e)
	}
	if aliasedHistory, er := s.CheckHistory(duplicate.RecordID, "", 8); er != nil || len(aliasedHistory["occurrences"].([]CheckOccurrence)) != 1 {
		t.Fatalf("alias history: %+v %v", aliasedHistory, er)
	}
	wrongKind := checkOperation(client, 18, "", "check.create", "", map[string]json.RawMessage{"title": field("baby")})
	wrongKind.CollectionID = "col_note"
	batch.Operations = []c.Operation{wrongKind}
	result, e = s.Mutate(batch)
	if e != nil || result[0].Outcome != "conflict" || result[0].Code != "invalid_input" {
		t.Fatalf("wrong collection: %+v %v", result, e)
	}
	unsupported := checkOperation(client, 19, "", "check.create", "", map[string]json.RawMessage{"title": field("baby"), "body": field("invalid")})
	batch.Operations = []c.Operation{unsupported}
	result, e = s.Mutate(batch)
	if e != nil || result[0].Outcome != "conflict" || result[0].Code != "invalid_input" {
		t.Fatalf("unsupported duplicate payload: %+v %v", result, e)
	}
	for i := 5; i < 17; i++ {
		op := checkOperation(client, i, "", "check.add", baby, map[string]json.RawMessage{"occurred_at": field("2026-09-27T12:00:00Z")})
		op.BaseRevision = "1" // Repeated independent commands remain additive.
		batch.Operations = []c.Operation{op}
		result, e = s.Mutate(batch)
		if e != nil || result[0].Outcome != "applied" || result[0].Record.Count != i-3 {
			t.Fatalf("add %d: %+v %v", i, result, e)
		}
	}
	batch.Operations = []c.Operation{checkOperation(client, 16, "", "check.add", baby, map[string]json.RawMessage{"occurred_at": field("2026-09-27T12:00:00Z")})}
	batch.Operations[0].BaseRevision = "1"
	result, e = s.Mutate(batch)
	if e != nil || !result[0].Duplicate || result[0].Record.Count != 13 {
		t.Fatalf("replay: %+v %v", result, e)
	}
	first, e := s.CheckHistory(baby, "", 8)
	if e != nil {
		t.Fatal(e)
	}
	rows := first["occurrences"].([]CheckOccurrence)
	if len(rows) != 8 || first["next_cursor"] == "" {
		t.Fatalf("first page: %+v", first)
	}
	second, e := s.CheckHistory(baby, first["next_cursor"].(string), 8)
	if e != nil || len(second["occurrences"].([]CheckOccurrence)) != 5 || second["next_cursor"] != "" {
		t.Fatalf("second page: %+v %v", second, e)
	}
	seen := map[string]bool{}
	for _, page := range []map[string]any{first, second} {
		for _, row := range page["occurrences"].([]CheckOccurrence) {
			if seen[row.ID] {
				t.Fatalf("duplicate history row %s", row.ID)
			}
			seen[row.ID] = true
		}
	}
	if len(seen) != 13 {
		t.Fatal(len(seen))
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	record, e := s.CheckByName("baby")
	if e != nil || record.Count != 13 {
		t.Fatalf("reopen: %+v %v", record, e)
	}
	var rowsInDB int
	if e = s.DB.QueryRow("SELECT count(*) FROM check_occurrences WHERE record_id=?", baby).Scan(&rowsInDB); e != nil || rowsInDB != 13 {
		t.Fatalf("rows: %d %v", rowsInDB, e)
	}
}
