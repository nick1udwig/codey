package httpapi

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/nick1udwig/pebble-agent/internal/agent"
)

type dashboardResponder struct {
	catalogResponder
	calls int
}

func (r *dashboardResponder) DashboardStatus(context.Context) (agent.DashboardStatus, error) {
	r.calls++
	return agent.DashboardStatus{State: "idle"}, nil
}
func TestStatusRequiresAuthentication(t *testing.T) {
	r := &dashboardResponder{}
	server := New(Config{Responder: r, Token: "secret"})
	for _, tc := range []struct {
		method, token string
		code          int
	}{{"GET", "", 401}, {"GET", "bad", 401}, {"POST", "secret", 405}, {"GET", "secret", 200}} {
		req := httptest.NewRequest(tc.method, "/v1/status", nil)
		req.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		server.ServeHTTP(w, req)
		if w.Code != tc.code {
			t.Fatal(w.Code, w.Body)
		}
	}
	if r.calls != 1 {
		t.Fatal(r.calls)
	}
}
