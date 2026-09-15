package httpapi

import (
	"encoding/json"
	"errors"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func collectionJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func collectionError(w http.ResponseWriter, e error) {
	var ce *c.Error
	if !errors.As(e, &ce) {
		ce = &c.Error{Code: "storage_error", Message: "Collection storage unavailable", Retryable: true}
	}
	status := 400
	switch ce.Code {
	case "auth_required":
		status = 401
	case "permission_denied":
		status = 403
	case "not_found":
		status = 404
	case "cursor_expired":
		status = 410
	case "stale_revision", "binding_changed", "store_epoch_changed", "server_mismatch", "idempotency_mismatch":
		status = 409
	case "storage_error":
		status = 503
	}
	collectionJSON(w, status, ce)
}
func collectionDecode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return c.Fail("invalid_input", "Invalid collection JSON")
	}
	if d.Decode(new(any)) != io.EOF {
		return c.Fail("invalid_input", "Unexpected trailing JSON")
	}
	return nil
}
func (s *Server) collection(w http.ResponseWriter, r *http.Request) {
	if s.config.Token == "" || !s.authorized(headerToken(r), "") {
		collectionError(w, c.Fail("auth_required", "Configure a server bearer token to use collections"))
		return
	}
	store := s.config.Collections
	if store == nil {
		collectionError(w, &c.Error{Code: "storage_error", Message: "Collections not configured", Retryable: true})
		return
	}
	p := r.URL.Path
	q := r.URL.Query()
	n, _ := strconv.Atoi(q.Get("limit"))
	var value any
	var err error
	switch {
	case p == "/v1/sync/info" && r.Method == "GET":
		value = map[string]any{"protocol_version": 1, "server_instance_id": store.ServerID, "store_epoch": store.Epoch, "principal": c.Principal, "ready": true, "max_body_bytes": c.MaxBodyBytes, "max_batch": 20}
	case p == "/v1/sync/recovery" && r.Method == "POST":
		var batch c.Batch
		err = collectionDecode(w, r, &batch)
		if err == nil {
			var results []c.Result
			results, err = store.PreserveRecovery(batch)
			value = map[string]any{"results": results}
		}
	case p == "/v1/sync/clients" && r.Method == "POST":
		var id string
		id, err = store.Enroll()
		value = map[string]any{"client_id": id, "server_instance_id": store.ServerID, "store_epoch": store.Epoch, "principal": c.Principal}
	case p == "/v1/collections" && r.Method == "GET":
		value, err = store.Collections()
	case p == "/v1/sync/mutations" && r.Method == "POST":
		var batch c.Batch
		err = collectionDecode(w, r, &batch)
		if err == nil {
			var results []c.Result
			results, err = store.Mutate(batch)
			value = map[string]any{"results": results}
		}
	case strings.HasPrefix(p, "/v1/sync/mutations/") && r.Method == "GET":
		value, err = store.Receipt(strings.TrimPrefix(p, "/v1/sync/mutations/"), false)
	case strings.HasPrefix(p, "/v1/sync/ingress/") && r.Method == "GET":
		value, err = store.Receipt(strings.TrimPrefix(p, "/v1/sync/ingress/"), true)
	case p == "/v1/sync/snapshots" && r.Method == "POST":
		var input struct {
			CollectionID string `json:"collection_id"`
			State        string `json:"state"`
		}
		err = collectionDecode(w, r, &input)
		if err == nil {
			value, err = store.Snapshot(input.CollectionID, input.State)
		}
	case strings.HasPrefix(p, "/v1/sync/snapshots/") && r.Method == "GET":
		value, err = store.SnapshotPage(strings.TrimPrefix(p, "/v1/sync/snapshots/"), q.Get("page_token"), n)
	case p == "/v1/sync/changes" && r.Method == "GET":
		value, err = store.Changes(q.Get("collection_id"), q.Get("cursor"), n)
	case strings.HasPrefix(p, "/v1/collections/") && strings.HasSuffix(p, "/records") && r.Method == "GET":
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/collections/"), "/records")
		snap, e := store.Snapshot(id, q.Get("state"))
		err = e
		if err == nil {
			value, err = store.SnapshotPage(snap.SnapshotID, "", n)
		}
	case strings.HasPrefix(p, "/v1/records/") && r.Method == "GET":
		id := strings.TrimPrefix(p, "/v1/records/")
		if strings.HasSuffix(id, "/body") {
			size, _ := strconv.Atoi(q.Get("max_bytes"))
			value, err = store.Body(strings.TrimSuffix(id, "/body"), q.Get("revision"), q.Get("cursor"), size)
		} else {
			var rec c.Record
			rec, err = store.Record(id, q.Get("revision"))
			if err == nil {
				w.Header().Set("ETag", `"`+rec.Revision+`"`)
				if r.Header.Get("If-None-Match") == `"`+rec.Revision+`"` {
					w.WriteHeader(304)
					return
				}
				value = rec.Summary()
			}
		}
	case strings.HasPrefix(p, "/v1/conflicts/") && r.Method == "GET":
		all, e := store.Conflicts()
		err = e
		if err == nil {
			err = c.Fail("not_found", "Conflict not found")
			for _, v := range all {
				if v.ID == strings.TrimPrefix(p, "/v1/conflicts/") {
					value = v
					err = nil
					break
				}
			}
		}
	case p == "/v1/conflicts" && r.Method == "GET":
		value, err = store.Conflicts()
	case p == "/v1/sync/status" && r.Method == "GET":
		value, err = store.Status()
	case p == "/v1/sync/refresh" && r.Method == "POST":
		if s.config.RefreshCollections != nil {
			s.config.RefreshCollections()
		}
		collectionJSON(w, 202, map[string]any{"scheduled": true})
		return
	default:
		collectionError(w, c.Fail("not_found", "Collection route or method not found"))
		return
	}
	if err != nil {
		collectionError(w, err)
		return
	}
	collectionJSON(w, 200, value)
}

func (s *Server) integrationAPI(w http.ResponseWriter, r *http.Request) {
	if s.config.Token == "" || !s.authorized(headerToken(r), "") {
		collectionError(w, c.Fail("auth_required", "Bearer token required"))
		return
	}
	if r.URL.Path == "/v1/integration-setup-sessions" && r.Method == "POST" && s.config.IntegrationSetup != nil {
		var input struct {
			PublicURL string `json:"public_url"`
		}
		if e := collectionDecode(w, r, &input); e != nil {
			collectionError(w, e)
			return
		}
		value, e := s.config.IntegrationSetup(input.PublicURL)
		if e != nil {
			collectionError(w, e)
			return
		}
		collectionJSON(w, 200, value)
		return
	}
	if r.URL.Path == "/v1/providers" && r.Method == "GET" && s.config.ProviderDescriptors != nil {
		collectionJSON(w, 200, s.config.ProviderDescriptors())
		return
	}
	if r.URL.Path == "/v1/integration-sessions" && r.Method == "POST" && s.config.IntegrationTicket != nil {
		var input struct {
			PublicURL  string `json:"public_url"`
			Collection string `json:"collection_id"`
			Provider   string `json:"provider"`
		}
		if e := collectionDecode(w, r, &input); e != nil {
			collectionError(w, e)
			return
		}
		u, e := s.config.IntegrationTicket(input.PublicURL, input.Provider, input.Collection)
		if e != nil {
			collectionError(w, e)
			return
		}
		collectionJSON(w, 200, map[string]string{"url": u})
		return
	}
	collectionError(w, c.Fail("not_found", "Integration route unavailable"))
}
