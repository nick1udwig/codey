package integrationauth

import (
	"context"
	"encoding/json"
	"github.com/nick1udwig/pebble-agent/internal/collectionstore"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type inlineNextcloud struct{ p.Nextcloud }

func (inlineNextcloud) Containers(_ context.Context, _ p.Binding, creds p.Credentials) ([]p.Container, error) {
	return []p.Container{{ID: "work", Name: "Work"}}, nil
}
func (inlineNextcloud) Pull(context.Context, p.Binding, p.Credentials, string) (p.Page, error) {
	return p.Page{}, nil
}
func TestInlineSetupEndToEndAndSessionIsolation(t *testing.T) {
	dir := t.TempDir()
	store, e := collectionstore.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	m, e := New(store, dir, Config{}, map[string]p.Adapter{"nextcloudnotes": inlineNextcloud{}})
	if e != nil {
		t.Fatal(e)
	}
	setup, e := m.SetupSession("https://server.test/codey")
	if e != nil {
		t.Fatal(e)
	}
	request := func(token, origin, method, body string) (int, map[string]any) {
		r := httptest.NewRequest(method, "/integrations/setup-api", strings.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		m.ServeHTTP(w, r)
		if origin == settingsOrigin && w.Header().Get("Access-Control-Allow-Origin") != settingsOrigin {
			t.Fatal("missing CORS")
		}
		if strings.Contains(w.Body.String(), "app-password") {
			t.Fatal("provider secret in response")
		}
		data := map[string]any{}
		if w.Code != 204 {
			if e := json.Unmarshal(w.Body.Bytes(), &data); e != nil {
				t.Fatal(w.Code, w.Body.String())
			}
		}
		return w.Code, data
	}
	if code, _ := request(setup["token"], "https://evil.test", "POST", "action=disconnect&collection=col_note&generation=1"); code != 403 {
		t.Fatal(code)
	}
	if code, _ := request("invalid", settingsOrigin, "GET", ""); code != 401 {
		t.Fatal(code)
	}
	if code, _ := request("", settingsOrigin, "OPTIONS", ""); code != 204 {
		t.Fatal(code)
	}
	code, data := request(setup["token"], settingsOrigin, "POST", "action=connect&collection=col_note&generation=1&provider=nextcloudnotes&endpoint=https%3A%2F%2Fcloud.test&username=nick&token=app-password")
	if code != 200 || data["candidate_id"] == nil {
		t.Fatal(code, data)
	}
	candidate := data["candidate_id"].(string)
	form := "candidate=" + url.QueryEscape(candidate) + "&container=work"
	other, _ := m.SetupSession("https://server.test/codey")
	if code, _ := request(other["token"], settingsOrigin, "POST", "action=apply&"+form); code != 400 {
		t.Fatal("cross-session candidate accepted")
	}
	if code, data = request(setup["token"], settingsOrigin, "POST", "action=bind&"+form); code != 200 || data["preview"] == nil {
		t.Fatal(code, data)
	}
	if code, data = request(setup["token"], settingsOrigin, "POST", "action=apply&"+form); code != 200 {
		t.Fatal(code, data)
	}
	if data["active"].(map[string]any)["col_note"] != "nextcloudnotes" {
		t.Fatal(data)
	}
	bindings, _ := store.Bindings()
	creds, e := m.Credentials(context.Background(), bindings[0])
	if e != nil || creds.Token != "app-password" {
		t.Fatal("provider credentials not saved", e)
	}
	m.mu.Lock()
	s := m.sessions[setup["token"]]
	s.Expires = time.Now().Add(-time.Second)
	m.sessions[setup["token"]] = s
	m.mu.Unlock()
	if code, _ := request(setup["token"], settingsOrigin, "GET", ""); code != 401 {
		t.Fatal(code)
	}
}
