package httpapi

import (
	"context"
	"encoding/json"
	"github.com/nick1udwig/pebble-agent/internal/jobs"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestJobRoutesAuthenticationAndPersistence(t *testing.T) {
	responder := &responderStub{}
	store, err := jobs.Open(t.TempDir(), 0, responder)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	server := New(Config{Responder: responder, Jobs: store, Token: "secret"})
	id := "123456789012345678901234567890"
	call := func(method, path, body, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	if w := call("POST", "/v1/jobs/"+id, requestDocument(""), ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := call("POST", "/v1/jobs/"+id, requestDocument(""), "secret"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	j, err := store.Get(context.Background(), id, time.Second)
	if err != nil || j.Status != "done" {
		t.Fatal(j, err)
	}
	w := call("GET", "/v1/jobs/"+id, "", "secret")
	j = jobs.Job{}
	if err := json.Unmarshal(w.Body.Bytes(), &j); err != nil {
		t.Fatal(err)
	}
	if j.Result == "" || j.Hash != "" {
		t.Fatal("missing result or leaked hash", j)
	}
	if w := call("POST", "/v1/jobs/"+id+"/ack", "", "secret"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := call("GET", "/v1/jobs/"+id+"?wait=121", "", "secret"); w.Code != 400 {
		t.Fatal(w.Code)
	}
}
