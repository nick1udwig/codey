package integrationauth

import (
	"fmt"

	c "github.com/nick1udwig/pebble-agent/internal/collections"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var pageTemplate = template.Must(template.New("settings").Parse(`<!doctype html><meta name="viewport" content="width=device-width"><title>Notes and to-dos sync</title><style>body{font:16px system-ui;max-width:48rem;margin:2rem auto;padding:1rem}label{display:block;margin:1rem 0}input,select,button{font:inherit;padding:.5rem;max-width:100%}fieldset{margin:1rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1 id="server">Notes and to-dos sync</h1><p>{{.Message}}</p><p>Records are saved on this server. External services are optional. Disconnecting preserves server and remote records.</p>
{{if .Candidate}}<h2>Select destination</h2><form method="post" action="{{$.Base}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="action" value="bind"><input type="hidden" name="candidate" value="{{.CandidateID}}"><label>Collection<select name="container">{{range .Candidate.Containers}}<option value="{{.ID}}">{{.Name}}</option>{{end}}</select></label><label><input type="checkbox" name="export" value="yes"> Copy existing server records outward (unchecked imports remote records only)</label><label><input type="checkbox" name="stop" value="yes"> Stop pending delivery to the previous service, retaining server records</label><button>Preview connection</button></form>{{end}}
{{if .Preview}}<h2>Connection preview</h2><p>{{.Preview}}</p><form method="post" action="{{$.Base}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="action" value="apply"><input type="hidden" name="candidate" value="{{.CandidateID}}"><input type="hidden" name="container" value="{{.Container}}"><input type="hidden" name="export" value="{{.Export}}"><input type="hidden" name="stop" value="{{.Stop}}"><button>Activate this destination</button></form>{{end}}
{{range .Collections}}<fieldset><legend>{{.Name}} · generation {{.Generation}}</legend><form method="post" action="{{$.Base}}"><input type="hidden" name="csrf" value="{{$.CSRF}}"><input type="hidden" name="action" value="disconnect"><input type="hidden" name="collection" value="{{.ID}}"><input type="hidden" name="generation" value="{{.Generation}}"><label><input type="checkbox" name="stop" value="yes"> Stop pending delivery to the old service</label><button>Use Server only</button></form>
{{$collection := .}}{{range $.Providers}}{{if eq .Kind $collection.Kind}}<h3 id="{{.ID}}">{{.Name}}</h3><p>{{.Limitations}}</p>{{if .Available}}<form method="post" action="{{$.Base}}"><input type="hidden" name="csrf" value="{{$.CSRF}}"><input type="hidden" name="action" value="connect"><input type="hidden" name="provider" value="{{.ID}}"><input type="hidden" name="collection" value="{{$collection.ID}}"><input type="hidden" name="generation" value="{{$collection.Generation}}">{{range .Fields}}<label>{{.Label}}<input name="{{.Name}}" type="{{if eq .Type "secret"}}password{{else if eq .Type "url"}}url{{else}}text{{end}}" autocomplete="off"></label>{{end}}<button>Connect / authorize</button></form>{{else}}<p>{{.UnavailableReason}}</p>{{end}}{{end}}{{end}}</fieldset>{{end}}
<h2>Delivery and recovery</h2><pre>{{.Status}}</pre><form method="post" action="{{$.Base}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="action" value="refresh"><button>Sync now</button></form><p>Unknown delivery is never retried automatically for providers without create deduplication. Inspect the remote record before deciding.</p>
{{range .Problems}}<pre>{{.}}</pre>{{end}}
<form method="post" action="{{$.Base}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="action" value="recover"><label>Provider operation ID<input name="job" required></label><label>Decision<select name="decision"><option value="stop">Stop delivery; preserve canonical data</option><option value="retry">I verified the remote operation did not apply; retry</option><option value="ack">I verified it applied; link the remote record below</option></select></label><label>Remote record ID (for link)<input name="remote"></label><button>Record recovery decision</button></form>
<form method="post" action="{{$.Base}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="action" value="resume"><label><input type="checkbox" name="confirmed" value="yes" required> I have reconciled restored provider operations against remote records</label><button>Resume providers after restore</button></form><h2>Conflicts</h2>{{range .Conflicts}}<pre>{{.}}</pre>{{end}}<form method="post" action="{{$.Base}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="action" value="resolve"><label>Conflict ID<input name="conflict" required></label><label>Observed current revision<input name="revision" required></label><label>Decision<select name="decision"><option value="keep">Keep current record; discard proposal</option><option value="proposal">Apply preserved proposal</option></select></label><button>Resolve conflict</button></form>`))

func (m *Manager) page(w http.ResponseWriter, s session, message string, extra map[string]any) {
	cols, e := m.Store.Collections()
	if e != nil {
		http.Error(w, "Collection storage unavailable", 503)
		return
	}
	if s.Collection != "" {
		for _, col := range cols {
			if col.ID == s.Collection {
				cols = []c.Collection{col}
				break
			}
		}
	}
	status, _ := m.Store.Status()
	bindings, _ := m.Store.Bindings()
	problems := []string{}
	for _, b := range bindings {
		jobs, _ := m.Store.Pending(b.ID)
		for _, j := range jobs {
			problems = append(problems, fmt.Sprintf("%s · %s · record %s · %s", j.ID, b.Provider, j.RecordID, j.State))
		}
	}
	conflicts, _ := m.Store.Conflicts()
	conf := []string{}
	for _, v := range conflicts {
		if !v.Resolved {
			conf = append(conf, string(p.Raw(v)))
		}
	}
	data := map[string]any{"Base": s.Base + "/integrations", "CSRF": s.CSRF, "Message": message, "Collections": cols, "Providers": m.Descriptors(), "Status": string(p.Raw(status)), "Problems": problems, "Conflicts": conf}
	for k, v := range extra {
		data[k] = v
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = pageTemplate.Execute(w, data)
}
func (m *Manager) action(w http.ResponseWriter, r *http.Request, sid string, s session) error {
	f := r.PostForm
	switch f.Get("action") {
	case "resume":
		if f.Get("confirmed") != "yes" {
			return fmt.Errorf("Confirm remote reconciliation first")
		}
		if e := m.Store.ResumeProviders(); e != nil {
			return e
		}
		if m.Refresh != nil {
			m.Refresh()
		}
		m.page(w, s, "Provider delivery resumed", nil)
	case "refresh":
		if m.Refresh != nil {
			m.Refresh()
		}
		m.page(w, s, "Refresh requested", nil)
	case "disconnect":
		if e := m.Store.Bind(p.Binding{CollectionID: f.Get("collection")}, f.Get("generation"), false, f.Get("stop") == "yes"); e != nil {
			return e
		}
		m.page(w, s, "Server only selected", nil)
	case "connect":
		provider := f.Get("provider")
		a := m.Adapters[provider]
		if a == nil {
			return c.Fail("invalid_input", "Unknown provider")
		}
		if provider == "googletasks" || provider == "todoist" && f.Get("token") == "" {
			return m.oauthStart(w, r, sid, provider, f.Get("collection"), f.Get("generation"))
		}
		binding := p.Binding{ID: c.ID("binding_"), Provider: provider, CollectionID: f.Get("collection"), Generation: f.Get("generation"), Endpoint: strings.TrimRight(f.Get("endpoint"), "/")}
		creds := p.Credentials{Token: f.Get("token"), Username: f.Get("username")}
		if creds.Token == "" {
			return fmt.Errorf("Credentials are required")
		}
		if provider == "nextcloudnotes" {
			if e := p.Endpoint(binding.Endpoint); e != nil {
				return e
			}
		}
		containers, e := a.Containers(r.Context(), binding, creds)
		if e != nil {
			return e
		}
		binding.Account = c.Hash([]string{provider, binding.Endpoint, creds.Username, creds.Token})
		candidate := candidate{Binding: binding, Credentials: creds, Containers: containers, Session: sid, Expires: time.Now().Add(10 * time.Minute)}
		m.mu.Lock()
		m.candidates[binding.ID] = candidate
		m.mu.Unlock()
		m.page(w, s, "Connection validated. Choose the destination and whether to export existing records.", map[string]any{"Candidate": candidate, "CandidateID": binding.ID})
	case "bind", "apply":
		m.mu.Lock()
		cand, ok := m.candidates[f.Get("candidate")]
		m.mu.Unlock()
		if !ok || cand.Session != sid || time.Now().After(cand.Expires) {
			return fmt.Errorf("Connection preview expired")
		}
		container := f.Get("container")
		found := false
		for _, v := range cand.Containers {
			if v.ID == container {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("Select a discovered collection")
		}
		cand.Binding.Container = container
		if f.Get("action") == "bind" {
			count := 0
			cursor := ""
			a := m.Adapters[cand.Binding.Provider]
			for pages := 0; pages < 10000; pages++ {
				page, e := a.Pull(r.Context(), cand.Binding, cand.Credentials, cursor)
				if e != nil {
					return e
				}
				for _, record := range page.Records {
					if record.Container == container {
						count++
					}
				}
				if page.Next == "" {
					break
				}
				if page.Next == cursor || pages == 9999 {
					return fmt.Errorf("Provider enumeration is incomplete")
				}
				cursor = page.Next
			}
			var local int
			m.Store.DB.QueryRow("SELECT count(*) FROM records WHERE collection_id=?", cand.Binding.CollectionID).Scan(&local)
			m.page(w, s, "", map[string]any{"Preview": fmt.Sprintf("%d remote records observed; %d server records. Export existing server records: %t. Repeated titles are kept as separate records.", count, local, f.Get("export") == "yes"), "CandidateID": cand.Binding.ID, "Container": container, "Export": f.Get("export"), "Stop": f.Get("stop")})
			return nil
		}
		if e := m.SaveCredentials(cand.Binding.ID, cand.Credentials); e != nil {
			return e
		}
		if e := m.Store.Bind(cand.Binding, cand.Binding.Generation, f.Get("export") == "yes", f.Get("stop") == "yes"); e != nil {
			return e
		}
		m.mu.Lock()
		delete(m.candidates, cand.Binding.ID)
		m.mu.Unlock()
		if m.Refresh != nil {
			m.Refresh()
		}
		m.page(w, s, "Destination activated", nil)
	case "recover":
		if e := m.recoverJob(r, f.Get("job"), f.Get("decision"), f.Get("remote")); e != nil {
			return e
		}
		m.page(w, s, "Recovery decision recorded", nil)
	case "resolve":
		if e := m.Store.ResolveConflict(f.Get("conflict"), f.Get("revision"), f.Get("decision") == "proposal"); e != nil {
			return e
		}
		m.page(w, s, "Conflict resolved", nil)
	default:
		return fmt.Errorf("Unknown management action")
	}
	return nil
}
func (m *Manager) oauthStart(w http.ResponseWriter, r *http.Request, sid, provider, col, generation string) error {
	conf := m.Config.OAuth[provider]
	if conf.ClientID == "" || conf.ClientSecret == "" || conf.RedirectURL == "" {
		return fmt.Errorf("Operator OAuth configuration is incomplete")
	}
	state := c.ID("oauth_")
	m.mu.Lock()
	m.states[state] = oauthState{Provider: provider, Session: sid, Collection: col, Generation: generation, Expires: time.Now().Add(5 * time.Minute)}
	m.mu.Unlock()
	endpoint := "https://accounts.google.com/o/oauth2/v2/auth"
	scope := "https://www.googleapis.com/auth/tasks"
	if provider == "todoist" {
		endpoint = "https://app.todoist.com/oauth/authorize"
		scope = "data:read_write,data:delete"
	}
	q := url.Values{"client_id": {conf.ClientID}, "redirect_uri": {conf.RedirectURL}, "response_type": {"code"}, "state": {state}, "scope": {scope}}
	if provider == "googletasks" {
		q.Set("access_type", "offline")
		q.Set("prompt", "consent")
	}
	http.Redirect(w, r, endpoint+"?"+q.Encode(), http.StatusSeeOther)
	return nil
}
func (m *Manager) callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	m.mu.Lock()
	pending, ok := m.states[state]
	delete(m.states, state)
	sess := m.sessions[pending.Session]
	m.mu.Unlock()
	if !ok || r.Method != "GET" || time.Now().After(pending.Expires) || time.Now().After(sess.Expires) {
		http.Error(w, "OAuth state expired or invalid", 400)
		return
	}
	conf := m.Config.OAuth[pending.Provider]
	creds, e := m.exchange(r.Context(), pending.Provider, url.Values{"grant_type": {"authorization_code"}, "code": {r.URL.Query().Get("code")}, "client_id": {conf.ClientID}, "client_secret": {conf.ClientSecret}, "redirect_uri": {conf.RedirectURL}})
	if e != nil {
		m.page(w, sess, "Authorization failed; reconnect", nil)
		return
	}
	binding := p.Binding{ID: c.ID("binding_"), CollectionID: pending.Collection, Provider: pending.Provider, Generation: pending.Generation, Account: c.Hash([]string{pending.Provider, creds.Token})}
	containers, e := m.Adapters[pending.Provider].Containers(r.Context(), binding, creds)
	if e != nil {
		m.page(w, sess, "Unable to discover provider collections", nil)
		return
	}
	cand := candidate{Binding: binding, Credentials: creds, Containers: containers, Session: pending.Session, Expires: time.Now().Add(10 * time.Minute)}
	m.mu.Lock()
	m.candidates[binding.ID] = cand
	m.mu.Unlock()
	m.page(w, sess, "Account connected", map[string]any{"Candidate": cand, "CandidateID": binding.ID})
}
func (m *Manager) recoverJob(r *http.Request, id, decision, remoteID string) error {
	bindings, e := m.Store.Bindings()
	if e != nil {
		return e
	}
	for _, b := range bindings {
		jobs, e := m.Store.Pending(b.ID)
		if e != nil {
			return e
		}
		for _, j := range jobs {
			if j.ID != id {
				continue
			}
			if j.State == "in_flight" {
				return fmt.Errorf("Operation is still in flight")
			}
			switch decision {
			case "stop":
				return m.Store.JobState(j, "stopped")
			case "retry":
				return m.Store.JobState(j, "pending")
			case "ack":
				creds, e := m.Credentials(r.Context(), b)
				if e != nil {
					return e
				}
				remote, e := m.Adapters[b.Provider].Fetch(r.Context(), b, creds, remoteID)
				if e != nil {
					return e
				}
				if remote.Container != b.Container {
					return fmt.Errorf("Remote record belongs to another destination")
				}
				return m.Store.Ack(j, remote)
			}
		}
	}
	return fmt.Errorf("Provider operation not found")
}
