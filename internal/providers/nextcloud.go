package providers

import (
	"context"
	"encoding/json"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"net/url"
	"strings"
)

type Nextcloud struct{ HTTP }

func (n Nextcloud) Describe() Descriptor {
	return Descriptor{AbsenceDeletion: true, ID: "nextcloudnotes", Name: "Nextcloud Notes", Kind: "note", Auth: []string{"app_password"}, Fields: []Field{{"endpoint", "Nextcloud base URL", "url"}, {"username", "Username", "text"}, {"token", "App password", "secret"}}, Capabilities: []string{"note.create", "note.append", "note.replace", "record.delete"}, Available: true, Limitations: "Requires Notes API 1.2+. Conditional note updates. Uncertain creates/deletes require review."}
}
func (n Nextcloud) base(b Binding) string {
	return strings.TrimRight(b.Endpoint, "/") + "/index.php/apps/notes/api/v1"
}
func nextRemote(raw json.RawMessage) (Remote, error) {
	var m map[string]json.RawMessage
	if e := json.Unmarshal(raw, &m); e != nil {
		return Remote{}, e
	}
	id := string(m["id"])
	if strings.HasPrefix(id, `"`) {
		id = Text(m, "id")
	}
	r := c.Record{Kind: "note", Title: Text(m, "title"), Body: Text(m, "content"), Format: "markdown", BodyComplete: true, Extensions: raw, Capabilities: []string{"note.append", "note.replace", "record.delete"}}
	if _, ok := m["content"]; !ok {
		r.BodyComplete = false
	}
	if Flag(m, "readonly") || Text(m, "etag") == "" || !r.BodyComplete {
		r.Capabilities = []string{}
	}
	r.BodyHash = c.Hash(r.Body)
	return Remote{ID: id, Container: Text(m, "category"), Version: Text(m, "etag"), Record: r, Raw: raw}, nil
}
func (n Nextcloud) Containers(ctx context.Context, b Binding, creds Credentials) ([]Container, error) {
	out := []Container{{"", "Uncategorized"}}
	seen := map[string]bool{"": true}
	page := ""
	for {
		p, e := n.Pull(ctx, b, creds, page)
		if e != nil {
			return nil, e
		}
		for _, r := range p.Records {
			if !seen[r.Container] {
				seen[r.Container] = true
				out = append(out, Container{r.Container, r.Container})
			}
		}
		if p.Next == "" {
			return out, nil
		}
		page = p.Next
	}
}
func (n Nextcloud) Pull(ctx context.Context, b Binding, creds Credentials, page string) (Page, error) {
	raw, h, e := n.request(ctx, "GET", n.base(b)+"/notes?pruneBefore=0&chunkSize=100"+func() string {
		if page != "" {
			return "&chunkCursor=" + url.QueryEscape(page)
		}
		return ""
	}(), creds, nil, "")
	if e != nil {
		return Page{}, e
	}
	var values []json.RawMessage
	if e = json.Unmarshal(raw, &values); e != nil {
		return Page{}, e
	}
	out := Page{Records: []Remote{}, Full: true}
	for _, v := range values {
		r, e := nextRemote(v)
		if e != nil {
			return out, e
		}
		out.Records = append(out.Records, r)
	}
	out.Next = h.Get("X-Notes-Chunk-Cursor")

	return out, nil
}
func (n Nextcloud) Fetch(ctx context.Context, b Binding, creds Credentials, id string) (Remote, error) {
	raw, _, e := n.request(ctx, "GET", n.base(b)+"/notes/"+path(id), creds, nil, "")
	if e != nil {
		return Remote{}, e
	}
	return nextRemote(raw)
}
func (n Nextcloud) Apply(ctx context.Context, b Binding, creds Credentials, id string, in Intent, base *Remote) (ApplyResult, error) {
	endpoint := n.base(b) + "/notes"
	method := "POST"
	etag := ""
	if base != nil {
		endpoint += "/" + path(base.ID)
		method = "PUT"
		etag = base.Version
		if etag == "" {
			return ApplyResult{State: "permanent_error"}, nil
		}
	}
	if in.Operation.Type == "record.delete" {
		method = "DELETE"
	}
	raw, _, e := n.request(ctx, method, endpoint, creds, map[string]any{"title": in.Record.Title, "content": in.Record.Body, "category": b.Container}, etag)
	if e != nil {
		return ApplyResult{}, e
	}
	if method == "DELETE" {
		r := *base
		r.Record.Deleted = true
		return ApplyResult{State: "applied", Remote: &r}, nil
	}
	r, e := nextRemote(raw)
	return ApplyResult{State: "applied", Remote: &r}, e
}
