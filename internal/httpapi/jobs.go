package httpapi

import (
	"encoding/json"
	"errors"
	"github.com/nick1udwig/pebble-agent/internal/jobs"
	"github.com/nick1udwig/pebble-agent/internal/pam"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *Server) job(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorized(headerToken(r), "") {
		http.Error(w, "unauthorized", 401)
		return
	}
	if s.config.Jobs == nil {
		http.Error(w, "background jobs unavailable; update the server", 503)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/jobs/"), "/")
	if len(parts) > 2 || !jobs.ValidID(parts[0]) {
		http.Error(w, "invalid job path", 400)
		return
	}
	id := parts[0]
	var j jobs.Job
	var err error
	if len(parts) == 2 {
		if r.Method != "POST" {
			http.Error(w, "POST required", 405)
			return
		}
		switch parts[1] {
		case "cancel":
			j, err = s.config.Jobs.Cancel(id)
		case "ack":
			j, err = s.config.Jobs.Acknowledge(id)
		default:
			http.NotFound(w, r)
			return
		}
	} else {
		switch r.Method {
		case "POST":
			body, readErr := readBody(w, r)
			if readErr != nil {
				http.Error(w, readErr.Error(), 400)
				return
			}
			parsed, parseErr := pam.ParseRequest(body)
			if parseErr != nil {
				http.Error(w, parseErr.Error(), 400)
				return
			}
			j, err = s.config.Jobs.Submit(id, parsed)
		case "GET":
			wait := 0
			if raw := r.URL.Query().Get("wait"); raw != "" {
				wait, err = strconv.Atoi(raw)
				if err != nil || wait < 0 || wait > 120 {
					http.Error(w, "wait must be 0..120 seconds", 400)
					return
				}
			}
			j, err = s.config.Jobs.Get(r.Context(), id, time.Duration(wait)*time.Second)
		default:
			http.Error(w, "GET or POST required", 405)
			return
		}
	}
	if err != nil {
		status := 500
		if errors.Is(err, jobs.ErrMissing) {
			status = 404
		}
		if errors.Is(err, jobs.ErrConflict) {
			status = 409
		}
		http.Error(w, err.Error(), status)
		return
	}
	j.Hash = ""
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(j)
}
