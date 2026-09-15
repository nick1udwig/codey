package integrationauth

import (
	"encoding/json"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"net/http"
	"strings"
	"time"
)

const settingsOrigin = "https://nick1udwig.github.io"

type inlineWriter struct{ http.ResponseWriter }

// SetupSession is issued only through the phone's bearer-authenticated API.
// It cannot access agent requests or collection mutation APIs.
func (m *Manager) SetupSession(base string) (map[string]string, error) {
	if e := p.Endpoint(base); e != nil {
		return nil, c.Fail("invalid_input", "Save an HTTPS server URL before configuring sync")
	}
	id := c.ID("setup_")
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, s := range m.sessions {
		if time.Now().After(s.Expires) {
			delete(m.sessions, key)
		}
	}
	m.sessions[id] = session{Inline: true, Base: strings.TrimRight(base, "/"), Expires: time.Now().Add(30 * time.Minute)}
	return map[string]string{"token": id, "url": strings.TrimRight(base, "/") + "/integrations/setup-api"}, nil
}
func inlineJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (m *Manager) serveInline(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Origin")
	origin := r.Header.Get("Origin")
	if origin != "" && origin != settingsOrigin {
		inlineJSON(w, 403, map[string]string{"message": "Settings origin is not allowed"})
		return
	}
	if origin == settingsOrigin {
		w.Header().Set("Access-Control-Allow-Origin", settingsOrigin)
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	id := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok || !s.Inline || time.Now().After(s.Expires) {
		inlineJSON(w, 401, map[string]string{"message": "Setup session expired. Reopen codey settings."})
		return
	}
	iw := inlineWriter{w}
	if r.Method == "GET" {
		m.page(iw, s, "", nil)
		return
	}
	if r.Method != "POST" {
		inlineJSON(w, 405, map[string]string{"message": "Method not allowed"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if e := r.ParseForm(); e != nil {
		inlineJSON(w, 400, map[string]string{"message": "Invalid setup form"})
		return
	}
	f := r.PostForm
	action := f.Get("action")
	switch action {
	case "connect", "disconnect", "authorize":
		col := f.Get("collection")
		if col != "col_note" && col != "col_task" && col != "col_event" {
			inlineJSON(w, 400, map[string]string{"message": "Choose Notes or To-dos"})
			return
		}
		if action != "disconnect" {
			a := m.Adapters[f.Get("provider")]
			if a == nil || "col_"+a.Describe().Kind != col {
				inlineJSON(w, 400, map[string]string{"message": "Provider does not support this collection"})
				return
			}
		}
		if action == "authorize" {
			u, e := m.Ticket(s.Base, f.Get("provider"), col)
			if e != nil {
				inlineJSON(w, 400, map[string]string{"message": e.Error()})
				return
			}
			inlineJSON(w, 200, map[string]string{"url": u})
			return
		}
		if action == "connect" && f.Get("token") == "" {
			inlineJSON(w, 400, map[string]string{"message": "Enter the provider token or app password"})
			return
		}
	case "bind", "apply":
	default:
		inlineJSON(w, 400, map[string]string{"message": "Unsupported setup action"})
		return
	}
	if e := m.action(iw, r, id, s); e != nil {
		inlineJSON(w, 400, map[string]string{"message": e.Error()})
	}
}

// Return only explicitly selected public fields. Never serialize candidate credentials.
func (m *Manager) inlinePage(w http.ResponseWriter, s session, message string, extra map[string]any) {
	cols, e := m.Store.Collections()
	if e != nil {
		inlineJSON(w, 503, map[string]string{"message": "Storage unavailable"})
		return
	}
	bindings, e := m.Store.Bindings()
	if e != nil {
		inlineJSON(w, 503, map[string]string{"message": "Binding state unavailable"})
		return
	}
	active := map[string]string{"col_task": "server", "col_note": "server", "col_event": "server"}
	for _, b := range bindings {
		if b.State == "active" {
			active[b.CollectionID] = b.Provider
		}
	}
	result := map[string]any{"message": message, "collections": cols, "providers": m.Descriptors(), "active": active}
	if v, ok := extra["Candidate"].(candidate); ok {
		result["candidate_id"] = extra["CandidateID"]
		result["containers"] = v.Containers
	}
	if v, ok := extra["Preview"]; ok {
		result["preview"] = v
		result["candidate_id"] = extra["CandidateID"]
	}
	inlineJSON(w, 200, result)
}
