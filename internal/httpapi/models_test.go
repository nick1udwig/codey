package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/nick1udwig/pebble-agent/internal/agent"
	"github.com/nick1udwig/pebble-agent/internal/pam"
)

type catalogResponder struct{ calls int }

func (*catalogResponder) Respond(context.Context, pam.Request, func([]byte) error) error { return nil }
func (r *catalogResponder) Models(context.Context) (agent.ModelCatalog, error) {
	r.calls++
	return agent.ModelCatalog{DefaultModel: "example", DefaultEffort: "high", Models: []agent.Model{{Model: "example"}}}, nil
}
func TestModelDiscoveryAuthenticationAndCORS(t *testing.T) {
	responder := &catalogResponder{}
	server := New(Config{Responder: responder, Token: "secret"})
	for _, tc := range []struct {
		method, token string
		status        int
	}{{"OPTIONS", "", 204}, {"GET", "", 401}, {"GET", "wrong", 401}, {"POST", "secret", 405}, {"GET", "secret", 200}} {
		request := httptest.NewRequest(tc.method, "/v1/models", nil)
		request.Header.Set("Authorization", "Bearer "+tc.token)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.method, response.Code, response.Body)
		}
		if response.Header().Get("Access-Control-Allow-Origin") != "*" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(response.Header())
		}
		if tc.status == 200 {
			var c agent.ModelCatalog
			if err := json.Unmarshal(response.Body.Bytes(), &c); err != nil || c.DefaultModel != "example" {
				t.Fatal(response.Body)
			}
		}
	}
	if responder.calls != 1 {
		t.Fatal("unauthenticated model lookup")
	}
}
