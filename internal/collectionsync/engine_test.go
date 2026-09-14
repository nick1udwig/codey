package collectionsync

import (
	"context"
	"encoding/json"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"github.com/nick1udwig/pebble-agent/internal/collectionstore"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"testing"
)

type fakeSecrets struct{}

func (fakeSecrets) Credentials(context.Context, p.Binding) (p.Credentials, error) {
	return p.Credentials{Token: "secret"}, nil
}

type fakeAdapter struct {
	applies    int
	unknown    bool
	pullFail   bool
	afterApply func()
}

func (f *fakeAdapter) Describe() p.Descriptor {
	return p.Descriptor{ID: "fake", Kind: "note", AbsenceDeletion: true}
}
func (f *fakeAdapter) Containers(context.Context, p.Binding, p.Credentials) ([]p.Container, error) {
	return []p.Container{{ID: "remote"}}, nil
}
func (f *fakeAdapter) Fetch(context.Context, p.Binding, p.Credentials, string) (p.Remote, error) {
	return p.Remote{}, &p.Failure{State: "not_found"}
}
func (f *fakeAdapter) Pull(_ context.Context, b p.Binding, _ p.Credentials, page string) (p.Page, error) {
	if f.pullFail {
		return p.Page{}, &p.Failure{State: "auth_required"}
	}
	return p.Page{Records: []p.Remote{{ID: "remote-id", Container: b.Container, Version: "v1", Record: c.Record{Kind: "note", Title: "A", Body: "B", BodyComplete: true}}}}, nil
}
func (f *fakeAdapter) Apply(_ context.Context, b p.Binding, _ p.Credentials, _ string, in p.Intent, _ *p.Remote) (p.ApplyResult, error) {
	f.applies++
	if f.afterApply != nil {
		f.afterApply()
	}
	if f.unknown {
		return p.ApplyResult{State: "delivery_unknown"}, nil
	}
	return p.ApplyResult{State: "applied", Remote: &p.Remote{ID: "remote-id", Container: b.Container, Version: "v1", Record: in.Record}}, nil
}
func fixture(t *testing.T) (*collectionstore.Store, *Engine, *fakeAdapter, c.Batch) {
	s, e := collectionstore.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	binding := p.Binding{ID: "binding", Provider: "fake", CollectionID: "col_note", Container: "remote"}
	if e = s.Bind(binding, "1", false, false); e != nil {
		t.Fatal(e)
	}
	client, e := s.Enroll()
	if e != nil {
		t.Fatal(e)
	}
	batch := c.Batch{Version: 1, ServerID: s.ServerID, Epoch: s.Epoch, ClientID: client, Operations: []c.Operation{{ID: "op:" + client + ":1", RecordID: "rec:" + client + ":1", Sequence: "1", IngressID: "one", CollectionID: "col_note", Generation: "2", Type: "note.create", Payload: map[string]json.RawMessage{"title": p.Raw("A"), "body": p.Raw("B")}}}}
	if _, e = s.Mutate(batch); e != nil {
		t.Fatal(e)
	}
	a := &fakeAdapter{pullFail: true}
	engine := New(s, map[string]p.Adapter{"fake": a}, fakeSecrets{})
	return s, engine, a, batch
}
func TestUnknownIsNotRetriedAndBindingCannotChange(t *testing.T) {
	s, e, a, _ := fixture(t)
	a.unknown = true
	e.Tick(context.Background())
	e.Tick(context.Background())
	if a.applies != 1 {
		t.Fatal(a.applies)
	}
	if err := s.Bind(p.Binding{CollectionID: "col_note"}, "2", false, true); err == nil {
		t.Fatal("switched uncertain destination")
	}
	jobs, _ := s.Pending("binding")
	if jobs[0].State != "delivery_unknown" {
		t.Fatal(jobs)
	}
}
func TestAckOlderRevisionKeepsNewWorkPending(t *testing.T) {
	s, e, a, b := fixture(t)
	a.afterApply = func() {
		a.afterApply = nil
		op := b.Operations[0]
		op.ID = "op:" + b.ClientID + ":2"
		op.Sequence = "2"
		op.IngressID = "two"
		op.Type = "note.append"
		op.BaseRevision = "1"
		op.Payload = map[string]json.RawMessage{"text": p.Raw("new")}
		b.Operations = []c.Operation{op}
		if _, err := s.Mutate(b); err != nil {
			t.Fatal(err)
		}
	}
	e.Tick(context.Background())
	r, err := s.Record(b.Operations[0].RecordID, "")
	if err != nil || r.Revision != "2" || r.ProviderState != "pending" {
		t.Fatal(r, err)
	}
	jobs, _ := s.Pending("binding")
	if len(jobs) != 1 || jobs[0].Revision != "2" {
		t.Fatal(jobs)
	}
}
func TestFailedEnumerationDoesNotDelete(t *testing.T) {
	s, e, a, b := fixture(t)
	e.Tick(context.Background())
	a.pullFail = true
	e.Tick(context.Background())
	r, err := s.Record(b.Operations[0].RecordID, "")
	if err != nil || r.Deleted {
		t.Fatal(r, err)
	}
}
