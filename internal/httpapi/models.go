package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/nick1udwig/pebble-agent/internal/agent"
)

type modelProvider interface {
	Models(context.Context) (agent.ModelCatalog, error)
}

func (server *Server) models(response http.ResponseWriter, request *http.Request) {
	// The public settings page uses explicit bearer authentication, never cookies.
	response.Header().Set("Access-Control-Allow-Origin", "*")
	response.Header().Set("Access-Control-Allow-Headers", "Authorization")
	response.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	response.Header().Set("Cache-Control", "no-store")
	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", "GET, OPTIONS")
		http.Error(response, "method not allowed", 405)
		return
	}
	if !server.authorized(headerToken(request), "") {
		http.Error(response, "unauthorized", 401)
		return
	}
	provider, ok := server.config.Responder.(modelProvider)
	if !ok {
		http.Error(response, "model discovery unavailable", 501)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
	defer cancel()
	catalog, err := provider.Models(ctx)
	if err != nil {
		http.Error(response, "Could not load Codex models", 502)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(catalog)
}
