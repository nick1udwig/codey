package integrationauth

import (
	"context"
	"github.com/nick1udwig/pebble-agent/internal/collectionstore"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEncryptedSecretsSingleUseTicketAndCSRF(t *testing.T) {
	dir := t.TempDir()
	store, e := collectionstore.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	m, e := New(store, dir, Config{PublicURL: "https://server.example/prefix"}, map[string]p.Adapter{"todoist": p.Todoist{}})
	if e != nil {
		t.Fatal(e)
	}
	secret := "not-in-database-plaintext"
	if e = m.SaveCredentials("binding", p.Credentials{Token: secret}); e != nil {
		t.Fatal(e)
	}
	var raw []byte
	store.DB.QueryRow("SELECT data FROM secrets").Scan(&raw)
	if strings.Contains(string(raw), secret) {
		t.Fatal("secret in plaintext")
	}
	creds, e := m.Credentials(context.Background(), p.Binding{ID: "binding"})
	if e != nil || creds.Token != secret {
		t.Fatal(e)
	}
	ticket, e := m.Ticket("", "")
	if e != nil {
		t.Fatal(e)
	}
	q := ticket[strings.Index(ticket, "?"):]
	r := httptest.NewRequest("GET", "https://server.example/integrations"+q, nil)
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	if w.Code != 303 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.Secure || !cookie.HttpOnly {
		t.Fatal(cookie)
	}
	again := httptest.NewRecorder()
	m.ServeHTTP(again, r)
	if again.Code != 401 {
		t.Fatal(again.Code)
	}
	post := httptest.NewRequest("POST", "/integrations", strings.NewReader("action=refresh"))
	post.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	post.AddCookie(cookie)
	w = httptest.NewRecorder()
	m.ServeHTTP(w, post)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	get := httptest.NewRequest("GET", "/integrations", nil)
	get.AddCookie(cookie)
	w = httptest.NewRecorder()
	m.ServeHTTP(w, get)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "https://server.example/prefix/integrations") {
		t.Fatal(w.Code, w.Body.String())
	}
	m.sessions[cookie.Value] = session{Expires: time.Now().Add(-time.Second)}
	w = httptest.NewRecorder()
	m.ServeHTTP(w, get)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	if e = os.Remove(filepath.Join(dir, "provider.key")); e != nil {
		t.Fatal(e)
	}
	if _, e = New(store, dir, Config{}, nil); e == nil {
		t.Fatal("silently replaced missing encryption key")
	}
}

func TestPhoneURLIsBoundToEachManagementSession(t *testing.T) {
	dir := t.TempDir()
	store, e := collectionstore.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	m, e := New(store, dir, Config{}, map[string]p.Adapter{"todoist": p.Todoist{}})
	if e != nil {
		t.Fatal(e)
	}
	for _, base := range []string{"http://example.test", "https://user:secret@example.test", "https://example.test?redirect=x"} {
		if _, e = m.Ticket(base, ""); e == nil {
			t.Fatal("accepted invalid base", base)
		}
	}
	first, e := m.Ticket("https://first.test/codey", "todoist")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Ticket("https://second.test/other", ""); e != nil {
		t.Fatal(e)
	}
	w := httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest("GET", first, nil))
	if w.Code != 303 || w.Header().Get("Location") != "https://first.test/codey/integrations#todoist" {
		t.Fatal(w.Code, w.Header().Get("Location"))
	}
	r := httptest.NewRequest("GET", "/integrations", nil)
	r.AddCookie(w.Result().Cookies()[0])
	w = httptest.NewRecorder()
	m.ServeHTTP(w, r)
	if !strings.Contains(w.Body.String(), `action="https://first.test/codey/integrations"`) || !strings.Contains(w.Body.String(), `id="todoist"`) {
		t.Fatal("wrong session base or missing selected provider")
	}
}
