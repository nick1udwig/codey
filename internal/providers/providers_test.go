package providers

import (
	"context"
	"encoding/json"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func reply(code int, body string) *http.Response {
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}
func TestGoogleCoverageConditionalAndDateOnly(t *testing.T) {
	calls := 0
	g := Google{HTTP: HTTP{Client: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method == "GET" {
			for _, k := range []string{"showHidden", "showCompleted", "showDeleted"} {
				if r.URL.Query().Get(k) != "true" {
					t.Fatal("missing", k)
				}
			}
			return reply(200, `{"items":[{"id":"a","title":"A","status":"completed","due":"2026-01-02T00:00:00Z","etag":"v1"}]}`), nil
		}
		if r.Header.Get("If-Match") != "v1" {
			t.Fatal("conditional write missing")
		}
		return reply(412, `{}`), nil
	})}}}
	page, e := g.Pull(context.Background(), Binding{Container: "list"}, Credentials{Token: "secret"}, "")
	if e != nil || !page.Records[0].Record.Completed || string(page.Records[0].Record.Due) != `{"date":"2026-01-02"}` {
		t.Fatal(page, e)
	}
	_, e = g.Apply(context.Background(), Binding{Container: "list"}, Credentials{}, "job", Intent{Operation: c.Operation{Type: "task.complete"}}, &page.Records[0])
	if State(e) != "conflict" || calls != 2 {
		t.Fatal(e, calls)
	}
}
func TestNextcloudChunkAndIfMatch(t *testing.T) {
	n := Nextcloud{HTTP: HTTP{Client: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.Method == "GET" {
			if strings.Contains(r.URL.RawQuery, "chunkCursor=") {
				t.Fatal("first chunk cursor must be omitted")
			}
			resp := reply(200, `[{"id":7,"title":"Note","content":"full 🌙","category":"work","etag":"version"}]`)
			resp.Header.Set("X-Notes-Chunk-Cursor", "opaque")
			return resp, nil
		}
		if r.Header.Get("If-Match") != "version" {
			t.Fatal("missing etag")
		}
		return reply(412, `{}`), nil
	})}}}
	b := Binding{Endpoint: "https://cloud.example/subdir", Container: "work"}
	page, e := n.Pull(context.Background(), b, Credentials{}, "")
	if e != nil || page.Next != "opaque" || page.Records[0].Record.Body != "full 🌙" {
		t.Fatal(page, e)
	}
	_, e = n.Apply(context.Background(), b, Credentials{}, "j", Intent{Operation: c.Operation{Type: "note.replace"}}, &page.Records[0])
	if State(e) != "conflict" {
		t.Fatal(e)
	}
}
func TestTodoistStableUUIDAndUnknownCreate(t *testing.T) {
	var uuids []string
	adapter := Todoist{HTTP: HTTP{Client: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		var payload struct {
			Commands []struct {
				UUID string `json:"uuid"`
			} `json:"commands"`
		}
		json.NewDecoder(r.Body).Decode(&payload)
		uuids = append(uuids, payload.Commands[0].UUID)
		return reply(503, `{}`), nil
	})}}}
	for i := 0; i < 2; i++ {
		result, e := adapter.Apply(context.Background(), Binding{}, Credentials{}, "stable-job", Intent{Operation: c.Operation{Type: "task.create"}, Record: c.Record{Title: "task"}}, nil)
		if e != nil || result.State != "retryable" {
			t.Fatal(result, e)
		}
	}
	if uuids[0] != uuids[1] || len(uuids[0]) != 36 {
		t.Fatal(uuids)
	}
	if State(classify(503, true)) != "delivery_unknown" {
		t.Fatal("blind retry")
	}
}
