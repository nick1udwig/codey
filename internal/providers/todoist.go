package providers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"net/url"
	"time"
)

type Todoist struct {
	HTTP
	Base string
}

func (t Todoist) base() string {
	if t.Base != "" {
		return t.Base
	}
	return "https://api.todoist.com/api/v1"
}
func (t Todoist) Describe() Descriptor {
	return Descriptor{IdempotentWrites: true, ID: "todoist", Name: "Todoist", Kind: "task", Auth: []string{"token", "oauth"}, Fields: []Field{{"token", "Personal API token", "secret"}}, Capabilities: []string{"task.create", "task.patch", "task.complete", "task.restore", "record.delete"}, Available: true, Limitations: "Sync command UUIDs deduplicate retries. Recurring completion advances one occurrence. Concurrent remote changes require review. Initial completed-task history covers the last 89 days; older canonical tasks remain stored."}
}
func (t Todoist) Containers(ctx context.Context, b Binding, creds Credentials) ([]Container, error) {
	out := []Container{}
	cursor := ""
	for {
		raw, _, e := t.request(ctx, "GET", t.base()+"/projects?limit=200&cursor="+url.QueryEscape(cursor), creds, nil, "")
		if e != nil {
			return nil, e
		}
		var p struct {
			Results []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"results"`
			Next string `json:"next_cursor"`
		}
		if e = json.Unmarshal(raw, &p); e != nil {
			return nil, e
		}
		for _, v := range p.Results {
			out = append(out, Container{v.ID, v.Name})
		}
		if p.Next == "" {
			return out, nil
		}
		cursor = p.Next
	}
}
func todoRemote(raw json.RawMessage) (Remote, error) {
	var m map[string]json.RawMessage
	if e := json.Unmarshal(raw, &m); e != nil {
		return Remote{}, e
	}
	r := c.Record{Kind: "task", Title: Text(m, "content"), Description: Text(m, "description"), Completed: Flag(m, "checked") || Flag(m, "is_completed"), Deleted: Flag(m, "is_deleted"), CompletedAt: Text(m, "completed_at"), Format: "plain", BodyComplete: true, Extensions: raw, Capabilities: []string{"task.patch", "task.complete", "task.restore", "record.delete"}}
	var due map[string]json.RawMessage
	if json.Unmarshal(m["due"], &due) == nil {
		if dt := Text(due, "datetime"); dt != "" {
			r.Due = Raw(map[string]string{"datetime": dt})
		} else if date := Text(due, "date"); date != "" {
			r.Due = Raw(map[string]string{"date": date})
		}
	}
	return Remote{ID: Text(m, "id"), Container: Text(m, "project_id"), Version: c.Hash([]any{r.Title, r.Description, r.Completed, r.CompletedAt, r.Deleted, r.Due, Text(m, "project_id"), m["due"]}), Record: r, Raw: raw}, nil
}

type todoCursor struct {
	Token  string
	Cursor string
	Since  string
	Until  string
}

func (t Todoist) Pull(ctx context.Context, b Binding, creds Credentials, page string) (Page, error) {
	var cur todoCursor
	if page != "" {
		raw, e := base64.RawURLEncoding.DecodeString(page)
		if e != nil {
			return Page{}, e
		}
		if e = json.Unmarshal(raw, &cur); e != nil {
			return Page{}, e
		}
	} else {
		token := b.Checkpoint
		if token == "" {
			token = "*"
		}
		raw, _, e := t.request(ctx, "POST", t.base()+"/sync", creds, map[string]any{"sync_token": token, "resource_types": []string{"items"}}, "")
		if e != nil {
			return Page{}, e
		}
		var result struct {
			Items []json.RawMessage `json:"items"`
			Token string            `json:"sync_token"`
		}
		if e = json.Unmarshal(raw, &result); e != nil {
			return Page{}, e
		}
		if result.Token == "" {
			return Page{}, &Failure{State: "retryable"}
		}
		out := Page{Records: []Remote{}}
		for _, raw := range result.Items {
			r, e := todoRemote(raw)
			if e != nil {
				return out, e
			}
			out.Records = append(out.Records, r)
		}
		cur = todoCursor{Token: result.Token, Since: time.Now().UTC().AddDate(0, 0, -89).Format(time.RFC3339), Until: time.Now().UTC().Format(time.RFC3339)}
		out.Next = base64.RawURLEncoding.EncodeToString(Raw(cur))
		return out, nil
	}
	q := url.Values{"project_id": {b.Container}, "since": {cur.Since}, "until": {cur.Until}, "limit": {"100"}, "cursor": {cur.Cursor}}
	raw, _, e := t.request(ctx, "GET", t.base()+"/tasks/completed/by_completion_date?"+q.Encode(), creds, nil, "")
	if e != nil {
		return Page{}, e
	}
	var result struct {
		Items []json.RawMessage `json:"items"`
		Next  string            `json:"next_cursor"`
	}
	if e = json.Unmarshal(raw, &result); e != nil {
		return Page{}, e
	}
	out := Page{Records: []Remote{}}
	for _, raw := range result.Items {
		remote, e := todoRemote(raw)
		if e != nil {
			return out, e
		}
		// Completion history can contain older occurrences of a currently active recurring task.
		current, e := t.Fetch(ctx, b, creds, remote.ID)
		if e == nil {
			remote = current
		} else if State(e) != "not_found" {
			return out, e
		} else {
			remote.Record.Completed = true
		}
		out.Records = append(out.Records, remote)
	}
	if result.Next != "" {
		cur.Cursor = result.Next
		out.Next = base64.RawURLEncoding.EncodeToString(Raw(cur))
	} else {
		out.Checkpoint = cur.Token
	}
	return out, nil
}

func (t Todoist) Fetch(ctx context.Context, b Binding, creds Credentials, id string) (Remote, error) {
	raw, _, e := t.request(ctx, "GET", t.base()+"/tasks/"+path(id), creds, nil, "")
	if e != nil {
		return Remote{}, e
	}
	return todoRemote(raw)
}
func (t Todoist) Apply(ctx context.Context, b Binding, creds Credentials, id string, in Intent, base *Remote) (ApplyResult, error) {
	args := map[string]any{}
	command := ""
	switch in.Operation.Type {
	case "task.create":
		command = "item_add"
		args["content"] = in.Record.Title
		args["description"] = in.Record.Description
		args["project_id"] = b.Container
	case "task.patch":
		command = "item_update"
		for k, v := range in.Operation.Payload {
			switch k {
			case "title":
				args["content"] = v
			case "description":
				args[k] = v
			case "due":
				args[k] = v
			}
		}
	case "task.complete":
		command = "item_close"
	case "task.restore":
		command = "item_uncomplete"
	case "record.delete":
		command = "item_delete"
	default:
		return ApplyResult{State: "permanent_error"}, nil
	}
	if base != nil {
		args["id"] = base.ID
	}
	uuid := UUID(id)
	cmd := map[string]any{"type": command, "uuid": uuid, "args": args}
	temp := UUID(id + ":record")
	if base == nil {
		cmd["temp_id"] = temp
	}
	raw, _, e := t.request(ctx, "POST", t.base()+"/sync", creds, map[string]any{"commands": []any{cmd}}, "")
	if e != nil {
		if State(e) == "delivery_unknown" {
			return ApplyResult{State: "retryable"}, nil
		}
		return ApplyResult{}, e
	}
	var result struct {
		Status  map[string]json.RawMessage `json:"sync_status"`
		Mapping map[string]string          `json:"temp_id_mapping"`
	}
	if e = json.Unmarshal(raw, &result); e != nil {
		return ApplyResult{State: "delivery_unknown"}, nil
	}
	if string(result.Status[uuid]) != `"ok"` {
		return ApplyResult{State: "permanent_error"}, nil
	}
	remoteID := ""
	if base != nil {
		remoteID = base.ID
	} else {
		remoteID = result.Mapping[temp]
	}
	if remoteID == "" {
		return ApplyResult{State: "delivery_unknown"}, nil
	}
	if in.Record.Deleted {
		r := *base
		r.Record.Deleted = true
		return ApplyResult{State: "applied", Remote: &r}, nil
	}
	r, e := t.Fetch(ctx, b, creds, remoteID)
	if e != nil {
		r = Remote{ID: remoteID, Container: b.Container, Record: in.Record}
		return ApplyResult{State: "applied", Remote: &r}, nil
	}
	return ApplyResult{State: "applied", Remote: &r}, nil
}
