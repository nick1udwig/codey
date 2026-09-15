package collectionstore

import (
	"encoding/json"
	"fmt"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"testing"
	"time"
)

func TestCalendarCreateOrderCountAndValidation(t *testing.T) {
	s, b := fixture(t)
	base := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	for i := 1; i <= 12; i++ {
		op := b.Operations[0]
		op.Sequence = fmt.Sprint(i)
		op.ID = "op:" + b.ClientID + ":" + op.Sequence
		op.RecordID = "rec:" + b.ClientID + ":" + op.Sequence
		op.IngressID = "event:" + op.Sequence
		op.CollectionID = "col_event"
		op.Type = "event.create"
		start := base.Add(time.Duration(12-i) * time.Hour)
		op.Payload = map[string]json.RawMessage{"title": field("Meeting"), "start": field(start.Format(time.RFC3339)), "end": field(start.Add(time.Hour).Format(time.RFC3339)), "description": field("Agenda")}
		b.Operations = []c.Operation{op}
		out, e := s.Mutate(b)
		if e != nil || out[0].Outcome != "applied" {
			t.Fatal(out, e)
		}
	}
	snap, e := s.Snapshot("col_event", "active")
	if e != nil {
		t.Fatal(e)
	}
	page, e := s.SnapshotPage(snap.SnapshotID, "", 8)
	if e != nil || len(page.Records) != 8 || page.Total != 12 || page.Records[0].Start != base.Format(time.RFC3339) || page.Next == "" {
		t.Fatal(page, e)
	}
	body, e := s.Body(page.Records[0].ID, page.Records[0].Revision, "", 100)
	if e != nil || body["body"] != "Agenda" {
		t.Fatal(body, e)
	}
	cols, e := s.Collections()
	if e != nil {
		t.Fatal(e)
	}
	for _, col := range cols {
		if col.Kind == "event" && col.Count != 12 {
			t.Fatal(col)
		}
	}
	op := b.Operations[0]
	op.RecordID = "fresh"
	op.Payload["end"] = op.Payload["start"]
	if _, e = c.Apply(nil, op, "event"); e == nil {
		t.Fatal("invalid interval")
	}
	op.Payload["end"] = field("2026-09-16T12:00:00")
	if _, e = c.Apply(nil, op, "event"); e == nil {
		t.Fatal("floating time")
	}
	if _, e = c.Apply(nil, op, "note"); e == nil {
		t.Fatal("wrong collection")
	}
}
func TestAgendaReconcileOnlyDeletesInsideCompleteWindow(t *testing.T) {
	s, _ := fixture(t)
	b := p.Binding{ID: "calendar", CollectionID: "col_event", Provider: "caldav", Generation: "1", Container: "work"}
	if e := s.Bind(b, "1", false, false); e != nil {
		t.Fatal(e)
	}
	start := time.Now().UTC()
	end := start.Add(90 * 24 * time.Hour)
	for _, id := range []string{"inside", "outside"} {
		at := start.Add(time.Hour)
		if id == "outside" {
			at = end.Add(time.Hour)
		}
		r := p.Remote{ID: id, Container: "work", Version: "v1", Record: c.Record{Kind: "event", Title: id, Start: at.Format(time.RFC3339), End: at.Add(time.Hour).Format(time.RFC3339), Capabilities: []string{}}}
		if e := s.Import(b, r); e != nil {
			t.Fatal(e)
		}
	}
	if e := s.ReconcileMissingWindow(b, map[string]bool{}, start, end); e != nil {
		t.Fatal(e)
	}
	snap, e := s.Snapshot("col_event", "all")
	if e != nil {
		t.Fatal(e)
	}
	page, e := s.SnapshotPage(snap.SnapshotID, "", 8)
	if e != nil || len(page.Records) != 1 || page.Records[0].Title != "outside" {
		t.Fatal(page, e)
	}
}

func TestAllDayVisibilityUsesPhoneDate(t *testing.T) {
	r := c.Record{Kind: "event", Start: "2026-09-15", End: "2026-09-16"}
	utc := time.Date(2026, 9, 16, 2, 0, 0, 0, time.UTC)
	if !c.Visible(r, "active", utc.In(time.FixedZone("west", -7*3600))) {
		t.Fatal("all-day event disappeared before local midnight")
	}
	if c.Visible(r, "active", utc.In(time.FixedZone("east", 9*3600))) {
		t.Fatal("ended all-day event still visible")
	}
}
