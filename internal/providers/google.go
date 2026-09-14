package providers

import (
	"context"
	"encoding/json"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"net/url"
	"strings"
)

type Google struct {
	HTTP
	Base string
}

func (g Google) base() string {
	if g.Base != "" {
		return g.Base
	}
	return "https://tasks.googleapis.com/tasks/v1"
}
func (g Google) Describe() Descriptor {
	return Descriptor{ID: "googletasks", Name: "Google Tasks", Kind: "task", Auth: []string{"oauth"}, Fields: []Field{}, Capabilities: []string{"task.create", "task.patch", "task.complete", "task.restore", "record.delete"}, Available: true, Limitations: "Date-only due values. Uncertain creates require review; assigned tasks are read-only."}
}
func (g Google) Containers(ctx context.Context, b Binding, c Credentials) ([]Container, error) {
	out := []Container{}
	next := ""
	for {
		raw, _, e := g.request(ctx, "GET", g.base()+"/users/@me/lists?maxResults=100&pageToken="+url.QueryEscape(next), c, nil, "")
		if e != nil {
			return nil, e
		}
		var p struct {
			Items []struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"items"`
			Next string `json:"nextPageToken"`
		}
		if e = json.Unmarshal(raw, &p); e != nil {
			return nil, e
		}
		for _, v := range p.Items {
			out = append(out, Container{v.ID, v.Title})
		}
		if p.Next == "" {
			return out, nil
		}
		next = p.Next
	}
}
func googleRemote(raw json.RawMessage, container string) (Remote, error) {
	var m map[string]json.RawMessage
	if e := json.Unmarshal(raw, &m); e != nil {
		return Remote{}, e
	}
	r := c.Record{Kind: "task", Title: Text(m, "title"), Description: Text(m, "notes"), Completed: Text(m, "status") == "completed", CompletedAt: Text(m, "completed"), Deleted: Flag(m, "deleted"), BodyComplete: true, Format: "plain", Extensions: raw, Capabilities: []string{"task.patch", "task.complete", "task.restore", "record.delete"}}
	if due := Text(m, "due"); len(due) >= 10 {
		r.Due = Raw(map[string]string{"date": due[:10]})
	}
	if len(m["assignmentInfo"]) > 0 && string(m["assignmentInfo"]) != "null" {
		r.Capabilities = []string{}
	}
	return Remote{ID: Text(m, "id"), Container: container, Version: Text(m, "etag"), Record: r, Raw: raw}, nil
}
func (g Google) Pull(ctx context.Context, b Binding, creds Credentials, page string) (Page, error) {
	u := g.base() + "/lists/" + path(b.Container) + "/tasks?maxResults=100&showCompleted=true&showHidden=true&showDeleted=true&pageToken=" + url.QueryEscape(page)
	raw, _, e := g.request(ctx, "GET", u, creds, nil, "")
	if e != nil {
		return Page{}, e
	}
	var p struct {
		Items []json.RawMessage `json:"items"`
		Next  string            `json:"nextPageToken"`
	}
	if e = json.Unmarshal(raw, &p); e != nil {
		return Page{}, e
	}
	out := Page{Records: []Remote{}, Next: p.Next, Full: true}
	for _, v := range p.Items {
		r, e := googleRemote(v, b.Container)
		if e != nil {
			return out, e
		}
		out.Records = append(out.Records, r)
	}
	return out, nil
}
func (g Google) Fetch(ctx context.Context, b Binding, creds Credentials, id string) (Remote, error) {
	raw, _, e := g.request(ctx, "GET", g.base()+"/lists/"+path(b.Container)+"/tasks/"+path(id), creds, nil, "")
	if e != nil {
		return Remote{}, e
	}
	return googleRemote(raw, b.Container)
}
func (g Google) Apply(ctx context.Context, b Binding, creds Credentials, id string, in Intent, base *Remote) (ApplyResult, error) {
	endpoint := g.base() + "/lists/" + path(b.Container) + "/tasks"
	method := "POST"
	etag := ""
	payload := map[string]any{}
	if base != nil {
		endpoint += "/" + path(base.ID)
		method = "PATCH"
		etag = base.Version
		if strings.Contains(string(base.Raw), `"assignmentInfo"`) {
			return ApplyResult{State: "permanent_error"}, nil
		}
	}
	switch in.Operation.Type {
	case "task.create":
		payload["title"] = in.Record.Title
		payload["notes"] = in.Record.Description
	case "task.patch":
		for k, v := range in.Operation.Payload {
			switch k {
			case "title":
				payload[k] = v
			case "description":
				payload["notes"] = v
			}
		}
	case "task.complete":
		payload["status"] = "completed"
	case "task.restore":
		payload["status"] = "needsAction"
		payload["completed"] = nil
	case "record.delete":
		method = "DELETE"
	default:
		return ApplyResult{State: "permanent_error"}, nil
	}
	if _, ok := in.Operation.Payload["due"]; ok {
		var due map[string]string
		json.Unmarshal(in.Record.Due, &due)
		if due["datetime"] != "" {
			return ApplyResult{State: "permanent_error"}, nil
		}
		if due["date"] != "" {
			payload["due"] = due["date"] + "T00:00:00.000Z"
		} else {
			payload["due"] = nil
		}
	}
	raw, _, e := g.request(ctx, method, endpoint, creds, payload, etag)
	if e != nil {
		return ApplyResult{}, e
	}
	if method == "DELETE" {
		r := *base
		r.Record.Deleted = true
		return ApplyResult{State: "applied", Remote: &r}, nil
	}
	r, e := googleRemote(raw, b.Container)
	return ApplyResult{State: "applied", Remote: &r}, e
}
