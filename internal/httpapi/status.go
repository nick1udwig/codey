package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/nick1udwig/pebble-agent/internal/agent"
)

type statusProvider interface {
	DashboardStatus(context.Context) (agent.DashboardStatus, error)
}

func (server *Server) status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", 405)
		return
	}
	if !server.authorized(headerToken(r), "") {
		http.Error(w, "unauthorized", 401)
		return
	}
	provider, ok := server.config.Responder.(statusProvider)
	if !ok {
		http.Error(w, "Codex status unavailable", 503)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	status, err := provider.DashboardStatus(ctx)
	if err != nil {
		http.Error(w, "Codex status unavailable", 503)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}
