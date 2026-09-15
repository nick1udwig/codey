package integrationauth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"github.com/nick1udwig/pebble-agent/internal/collectionstore"
	p "github.com/nick1udwig/pebble-agent/internal/providers"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type OAuthConfig struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	RedirectURL  string `json:"redirect_url"`
}
type Config struct {
	PublicURL    string                 `json:"public_url"`
	OAuth        map[string]OAuthConfig `json:"oauth"`
	PrivateHosts []string               `json:"private_hosts"`
}
type ticket struct {
	Collection string
	Expires    time.Time
	Base       string
	Provider   string
}
type session struct {
	Inline     bool
	Collection string
	Base       string
	Provider   string
	CSRF       string
	Expires    time.Time
}
type candidate struct {
	Binding     p.Binding
	Credentials p.Credentials
	Containers  []p.Container
	Session     string
	Expires     time.Time
}
type oauthState struct {
	Provider   string
	Session    string
	Collection string
	Generation string
	Expires    time.Time
}
type Manager struct {
	Store      *collectionstore.Store
	Adapters   map[string]p.Adapter
	Config     Config
	HTTP       *http.Client
	Refresh    func()
	mu         sync.Mutex
	refreshMu  sync.Mutex
	aead       cipher.AEAD
	tickets    map[string]ticket
	sessions   map[string]session
	candidates map[string]candidate
	states     map[string]oauthState
}

func New(store *collectionstore.Store, dir string, config Config, adapters map[string]p.Adapter) (*Manager, error) {
	keyPath := filepath.Join(dir, "provider.key")
	key, e := os.ReadFile(keyPath)
	if errors.Is(e, os.ErrNotExist) {
		var count int
		if e = store.DB.QueryRow("SELECT count(*) FROM secrets").Scan(&count); e != nil {
			return nil, e
		}
		if count > 0 {
			return nil, fmt.Errorf("provider encryption key missing; restore key before starting")
		}
		key = make([]byte, 32)
		if _, e = rand.Read(key); e != nil {
			return nil, e
		}
		f, err := os.OpenFile(keyPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		_, e = f.Write(key)
		if e == nil {
			e = f.Sync()
		}
		f.Close()
	}
	if e != nil {
		return nil, e
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	aead, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	return &Manager{Store: store, Adapters: adapters, Config: config, HTTP: p.SafeClient(config.PrivateHosts), aead: aead, tickets: map[string]ticket{}, sessions: map[string]session{}, candidates: map[string]candidate{}, states: map[string]oauthState{}}, nil
}
func (m *Manager) SaveCredentials(id string, creds p.Credentials) error {
	nonce := make([]byte, m.aead.NonceSize())
	if _, e := rand.Read(nonce); e != nil {
		return e
	}
	encrypted := m.aead.Seal(nonce, nonce, p.Raw(creds), []byte(id))
	_, e := m.Store.DB.Exec("INSERT INTO secrets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", id, encrypted)
	return e
}
func (m *Manager) Credentials(ctx context.Context, b p.Binding) (p.Credentials, error) {
	m.refreshMu.Lock()
	defer m.refreshMu.Unlock()
	var encrypted []byte
	if e := m.Store.DB.QueryRow("SELECT data FROM secrets WHERE id=?", b.ID).Scan(&encrypted); e != nil {
		return p.Credentials{}, e
	}
	n := m.aead.NonceSize()
	if len(encrypted) < n {
		return p.Credentials{}, fmt.Errorf("invalid encrypted secret")
	}
	raw, e := m.aead.Open(nil, encrypted[:n], encrypted[n:], []byte(b.ID))
	if e != nil {
		return p.Credentials{}, e
	}
	var creds p.Credentials
	if e = json.Unmarshal(raw, &creds); e != nil {
		return creds, e
	}
	if creds.RefreshToken != "" && time.Now().Add(time.Minute).After(creds.Expiry) {
		conf := m.Config.OAuth[b.Provider]
		if conf.ClientID == "" {
			return creds, fmt.Errorf("OAuth operator configuration missing")
		}
		next, e := m.exchange(ctx, b.Provider, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {creds.RefreshToken}, "client_id": {conf.ClientID}, "client_secret": {conf.ClientSecret}})
		if e != nil {
			return creds, e
		}
		if next.RefreshToken == "" {
			next.RefreshToken = creds.RefreshToken
		}
		if e = m.SaveCredentials(b.ID, next); e != nil {
			return creds, e
		}
		creds = next
	}
	return creds, nil
}
func (m *Manager) exchange(ctx context.Context, provider string, values url.Values) (p.Credentials, error) {
	endpoint := "https://oauth2.googleapis.com/token"
	if provider == "todoist" {
		endpoint = "https://api.todoist.com/oauth/access_token"
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(values.Encode()))
	if e != nil {
		return p.Credentials{}, e
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := m.HTTP.Do(req)
	if e != nil {
		return p.Credentials{}, fmt.Errorf("OAuth exchange unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return p.Credentials{}, fmt.Errorf("OAuth exchange rejected")
	}
	var body struct {
		Token   string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Seconds int    `json:"expires_in"`
	}
	if e = json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&body); e != nil || body.Token == "" {
		return p.Credentials{}, fmt.Errorf("Invalid OAuth token response")
	}
	expiry := time.Time{}
	if body.Seconds > 0 {
		expiry = time.Now().Add(time.Duration(body.Seconds) * time.Second)
	}
	return p.Credentials{Token: body.Token, RefreshToken: body.Refresh, Expiry: expiry}, nil
}
func (m *Manager) Descriptors() []p.Descriptor {
	out := []p.Descriptor{}
	ids := []string{}
	for id := range m.Adapters {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		a := m.Adapters[id]
		if a == nil {
			continue
		}
		d := a.Describe()
		if id == "googletasks" && m.Config.OAuth[id].ClientID == "" {
			d.Available = false
			d.UnavailableReason = "Operator must configure Google OAuth client and callback URL"
		}
		out = append(out, d)
	}
	return out
}
func (m *Manager) Ticket(base, provider, collection string) (string, error) {
	if base == "" {
		base = m.Config.PublicURL
	}
	if e := p.Endpoint(base); e != nil {
		return "", c.Fail("invalid_input", "Use an HTTPS server URL in phone settings to manage sync services")
	}
	if provider != "" && provider != "server" && m.Adapters[provider] == nil {
		return "", c.Fail("invalid_input", "Unknown sync service")
	}
	if collection != "" && collection != "col_task" && collection != "col_note" {
		return "", c.Fail("invalid_input", "Unknown collection")
	}
	if a := m.Adapters[provider]; a != nil && collection != "" && "col_"+a.Describe().Kind != collection {
		return "", c.Fail("invalid_input", "Service does not support this collection")
	}
	base = strings.TrimRight(base, "/")
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, t := range m.tickets {
		if time.Now().After(t.Expires) {
			delete(m.tickets, k)
		}
	}
	ticket := c.ID("ticket_")
	m.tickets[ticket] = ticketInfo(base, provider, collection)
	return base + "/integrations?ticket=" + url.QueryEscape(ticket), nil
}
func ticketInfo(base, provider, collection string) ticket {
	return ticket{Collection: collection, Expires: time.Now().Add(5 * time.Minute), Base: base, Provider: provider}
}
func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/integrations/setup-api" {
		m.serveInline(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/integrations/oauth/callback" {
		m.callback(w, r)
		return
	}
	ticket := r.URL.Query().Get("ticket")
	if ticket != "" && r.Method == "GET" {
		m.mu.Lock()
		issued, ok := m.tickets[ticket]
		delete(m.tickets, ticket)
		if !ok || time.Now().After(issued.Expires) {
			m.mu.Unlock()
			http.Error(w, "Ticket expired; reopen settings from the phone", 401)
			return
		}
		id := c.ID("session_")
		m.sessions[id] = session{Collection: issued.Collection, Base: issued.Base, Provider: issued.Provider, CSRF: c.ID("csrf_"), Expires: time.Now().Add(30 * time.Minute)}
		m.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: "codey_integrations", Value: id, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode, MaxAge: 1800})
		http.Redirect(w, r, issued.Base+"/integrations#"+url.QueryEscape(issued.Provider), http.StatusSeeOther)
		return
	}
	cookie, e := r.Cookie("codey_integrations")
	if e != nil {
		http.Error(w, "Open integrations from phone settings", 401)
		return
	}
	m.mu.Lock()
	sess, ok := m.sessions[cookie.Value]
	m.mu.Unlock()
	if !ok || sess.Inline || time.Now().After(sess.Expires) {
		http.Error(w, "Management session expired", 401)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if r.Method == "POST" {
		if e = r.ParseForm(); e != nil || r.PostForm.Get("csrf") != sess.CSRF {
			http.Error(w, "Invalid management form", 403)
			return
		}
		if e = m.action(w, r, cookie.Value, sess); e != nil {
			m.page(w, sess, e.Error(), nil)
		}
		return
	}
	if r.Method != "GET" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	m.page(w, sess, "", nil)
}
