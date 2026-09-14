// Package collections defines the provider-neutral collection protocol.
package collections

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const ProtocolVersion = 1
const MaxBodyBytes = 256 << 10
const Principal = "operator"

type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (e *Error) Error() string        { return e.Message }
func Fail(code, message string) error { return &Error{Code: code, Message: message} }
func ID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(b[:])
}
func Hash(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func Next(v string) string { n, _ := strconv.ParseUint(v, 10, 64); return strconv.FormatUint(n+1, 10) }
func Now() string          { return time.Now().UTC().Format(time.RFC3339Nano) }

type Collection struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Generation string `json:"binding_generation"`
	BindingID  string `json:"binding_id,omitempty"`
}
type Record struct {
	ID            string          `json:"id"`
	CollectionID  string          `json:"collection_id"`
	Kind          string          `json:"kind"`
	Revision      string          `json:"revision"`
	Title         string          `json:"title"`
	Body          string          `json:"body,omitempty"`
	Format        string          `json:"body_format,omitempty"`
	BodyHash      string          `json:"body_hash,omitempty"`
	BodyComplete  bool            `json:"body_complete"`
	Description   string          `json:"description,omitempty"`
	Completed     bool            `json:"completed"`
	CompletedAt   string          `json:"completed_at,omitempty"`
	Due           json.RawMessage `json:"due,omitempty"`
	Deleted       bool            `json:"deleted"`
	CreatedAt     string          `json:"created_at"`
	UpdatedAt     string          `json:"updated_at"`
	Extensions    json.RawMessage `json:"extensions,omitempty"`
	Capabilities  []string        `json:"capabilities"`
	ProviderState string          `json:"provider_state"`
}

func (r Record) Summary() Record { r.Body = ""; r.Description = ""; r.Extensions = nil; return r }

type Operation struct {
	ID              string                     `json:"id"`
	IngressID       string                     `json:"ingress_id"`
	Sequence        string                     `json:"sequence"`
	CollectionID    string                     `json:"collection_id"`
	Generation      string                     `json:"binding_generation"`
	RecordID        string                     `json:"record_id"`
	Type            string                     `json:"type"`
	BaseRevision    string                     `json:"base_revision,omitempty"`
	BaseOperationID string                     `json:"base_operation_id,omitempty"`
	DependsOn       []string                   `json:"depends_on"`
	Payload         map[string]json.RawMessage `json:"payload"`
}
type Batch struct {
	Version    int         `json:"protocol_version"`
	ServerID   string      `json:"server_instance_id"`
	Epoch      string      `json:"store_epoch"`
	ClientID   string      `json:"client_id"`
	Operations []Operation `json:"operations"`
}
type Result struct {
	OperationID   string  `json:"operation_id"`
	Outcome       string  `json:"outcome"`
	Durable       bool    `json:"durably_recorded"`
	RecordID      string  `json:"record_id,omitempty"`
	Revision      string  `json:"revision,omitempty"`
	Sequence      string  `json:"change_sequence,omitempty"`
	ProviderState string  `json:"provider_state,omitempty"`
	ConflictID    string  `json:"conflict_id,omitempty"`
	Code          string  `json:"code,omitempty"`
	Duplicate     bool    `json:"duplicate,omitempty"`
	Record        *Record `json:"record,omitempty"`
}
type Receipt struct {
	ClientID string    `json:"client_id"`
	Request  Operation `json:"request"`
	Hash     string    `json:"hash"`
	Result   Result    `json:"result"`
}
type Conflict struct {
	ID        string    `json:"id"`
	Operation Operation `json:"operation"`
	Current   *Record   `json:"current"`
	Resolved  bool      `json:"resolved"`
	Cause     string    `json:"cause"`
}
type Change struct {
	Sequence string `json:"sequence"`
	Record   Record `json:"record"`
}

// Apply validates all supplied fields before altering the canonical record.
func Apply(old *Record, op Operation, kind string) (Record, error) {
	r := Record{ID: op.RecordID, CollectionID: op.CollectionID, Kind: kind, Revision: "0", CreatedAt: Now(), BodyComplete: true, Format: "plain", ProviderState: "server_only"}
	if old != nil {
		r = *old
	}
	create := op.Type == "task.create" || op.Type == "note.create"
	if create && old != nil {
		return r, Fail("record_exists", "Record already exists")
	}
	if !create && old == nil {
		return r, Fail("not_found", "Record does not exist")
	}
	if old != nil && !create {
		allowed := false
		for _, cap := range old.Capabilities {
			if cap == op.Type {
				allowed = true
			}
		}
		if !allowed {
			return r, Fail("permission_denied", "Record does not support this action")
		}
	}
	if r.Deleted {
		return r, Fail("deleted", "Deleted records cannot be edited")
	}
	if strings.HasPrefix(op.Type, "task.") && kind != "task" || strings.HasPrefix(op.Type, "note.") && kind != "note" {
		return r, Fail("invalid_input", "Operation kind does not match collection")
	}
	allowed := map[string]bool{}
	switch op.Type {
	case "task.create", "task.patch":
		for _, k := range []string{"title", "description", "due"} {
			allowed[k] = true
		}
	case "note.create":
		for _, k := range []string{"title", "body", "body_format"} {
			allowed[k] = true
		}
	case "note.replace":
		allowed["body"] = true
		allowed["whole_note"] = true
		var yes bool
		if json.Unmarshal(op.Payload["whole_note"], &yes) != nil || !yes {
			return r, Fail("invalid_input", "Whole-note intent is required")
		}
	case "note.append":
		allowed["text"] = true
	case "task.complete", "task.restore":
		allowed["occurrence_id"] = true
	case "record.delete":
	default:
		return r, Fail("invalid_input", "Unknown operation type")
	}
	for k, v := range op.Payload {
		if !allowed[k] {
			return r, Fail("invalid_input", "Unsupported field: "+k)
		}
		if k == "whole_note" || k == "occurrence_id" {
			continue
		}
		if k == "due" {
			if string(v) != "null" {
				var d struct {
					Date     string `json:"date"`
					DateTime string `json:"datetime"`
				}
				if json.Unmarshal(v, &d) != nil || (d.Date == "") == (d.DateTime == "") {
					return r, Fail("invalid_input", "Due must contain date or datetime")
				}
				if d.Date != "" {
					if _, e := time.Parse("2006-01-02", d.Date); e != nil {
						return r, Fail("invalid_input", "Invalid due date")
					}
				} else if _, e := time.Parse(time.RFC3339, d.DateTime); e != nil {
					return r, Fail("invalid_input", "Invalid due datetime")
				}
			}
			r.Due = v
			continue
		}
		var s string
		if string(v) == "null" || json.Unmarshal(v, &s) != nil || !utf8.ValidString(s) || strings.ContainsRune(s, 0) {
			return r, Fail("invalid_input", "Text field is invalid")
		}
		switch k {
		case "title":
			r.Title = s
		case "description":
			r.Description = s
		case "body":
			r.Body = s
		case "body_format":
			r.Format = s
		case "text":
			r.Body += s
		}
	}
	if op.Type == "task.complete" {
		r.Completed = true
		r.CompletedAt = Now()
	}
	if op.Type == "task.restore" {
		r.Completed = false
		r.CompletedAt = ""
	}
	if op.Type == "record.delete" {
		r.Deleted = true
	}
	if strings.TrimSpace(r.Title) == "" || len(r.Title) > 4096 || len(r.Body) > MaxBodyBytes || len(r.Description) > MaxBodyBytes {
		return r, Fail("invalid_input", "Title or content exceeds collection limits")
	}
	if r.Format != "plain" && r.Format != "markdown" {
		return r, Fail("invalid_input", "Unsupported body format")
	}
	if (op.Type == "note.replace" || op.Type == "note.append") && !r.BodyComplete {
		return r, Fail("permission_denied", "Incomplete content is read-only")
	}
	r.Revision = Next(r.Revision)
	r.UpdatedAt = Now()
	r.BodyHash = Hash(r.Body)
	if kind == "note" {
		r.Capabilities = []string{"note.append", "note.replace", "record.delete"}
	} else {
		r.Capabilities = []string{"task.patch", "task.complete", "task.restore", "record.delete"}
	}
	return r, nil
}
func ValidateIdentity(client string, op Operation) error {
	n, e := strconv.ParseUint(op.Sequence, 10, 64)
	if e != nil || n == 0 || strconv.FormatUint(n, 10) != op.Sequence || op.ID != "op:"+client+":"+op.Sequence {
		return Fail("invalid_input", "Invalid operation identity")
	}
	if op.IngressID == "" || len(op.IngressID) > 512 || op.RecordID == "" || len(op.RecordID) > 256 {
		return Fail("invalid_input", "Missing or oversized identity")
	}
	if strings.HasSuffix(op.Type, ".create") && op.RecordID != "rec:"+client+":"+op.Sequence {
		return Fail("invalid_input", fmt.Sprintf("Create requires client-owned record identity"))
	}
	return nil
}
