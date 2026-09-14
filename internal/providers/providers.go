// Package providers contains server-only adapters. No provider credentials or
// provider-specific branching crosses the phone/watch protocol boundary.
package providers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Field struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Type  string `json:"type"`
}
type Descriptor struct {
	IdempotentWrites  bool     `json:"idempotent_writes"`
	AbsenceDeletion   bool     `json:"absence_deletion"`
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Kind              string   `json:"kind"`
	Auth              []string `json:"auth"`
	Fields            []Field  `json:"fields"`
	Capabilities      []string `json:"capabilities"`
	Limitations       string   `json:"limitations"`
	Available         bool     `json:"available"`
	UnavailableReason string   `json:"unavailable_reason,omitempty"`
}
type Credentials struct {
	Token        string    `json:"token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	Username     string    `json:"username,omitempty"`
	Expiry       time.Time `json:"expiry,omitempty"`
}
type Binding struct {
	ID           string `json:"id"`
	CollectionID string `json:"collection_id"`
	Provider     string `json:"provider"`
	Endpoint     string `json:"endpoint,omitempty"`
	Container    string `json:"container"`
	Account      string `json:"account"`
	Generation   string `json:"generation"`
	Checkpoint   string `json:"checkpoint"`
	State        string `json:"state"`
	SecretID     string `json:"-"`
}
type Container struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Remote struct {
	ID        string          `json:"id"`
	Container string          `json:"container"`
	Version   string          `json:"version"`
	Record    c.Record        `json:"record"`
	Raw       json.RawMessage `json:"raw"`
}
type Page struct {
	Records    []Remote
	Next       string
	Checkpoint string
	Full       bool
}
type Intent struct {
	Operation   c.Operation `json:"operation"`
	Record      c.Record    `json:"record"`
	Base        *c.Record   `json:"base"`
	Attempts    int         `json:"attempts"`
	NextAttempt time.Time   `json:"next_attempt"`
}
type ApplyResult struct {
	State     string
	Remote    *Remote
	Reference string
}
type Adapter interface {
	Describe() Descriptor
	Containers(context.Context, Binding, Credentials) ([]Container, error)
	Pull(context.Context, Binding, Credentials, string) (Page, error)
	Fetch(context.Context, Binding, Credentials, string) (Remote, error)
	Apply(context.Context, Binding, Credentials, string, Intent, *Remote) (ApplyResult, error)
}
type Failure struct {
	State  string
	Status int
}

func (e *Failure) Error() string { return "Provider request: " + e.State }
func classify(status int, write bool) error {
	state := "permanent_error"
	switch {
	case status == 401 || status == 403:
		state = "auth_required"
	case status == 409 || status == 412:
		state = "conflict"
	case status == 429:
		state = "retryable"
	case status >= 500:
		if write {
			state = "delivery_unknown"
		} else {
			state = "retryable"
		}
	case status == 404:
		state = "not_found"
	}
	return &Failure{state, status}
}
func State(e error) string {
	if f, ok := e.(*Failure); ok {
		return f.State
	}
	return "retryable"
}
func UUID(id string) string {
	h := sha256.Sum256([]byte(id))
	b := h[:16]
	b[6] = (b[6] & 15) | 80
	b[8] = (b[8] & 63) | 128
	s := hex.EncodeToString(b)
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}
func Raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func Text(m map[string]json.RawMessage, k string) string {
	var s string
	_ = json.Unmarshal(m[k], &s)
	return s
}
func Flag(m map[string]json.RawMessage, k string) bool {
	var b bool
	if json.Unmarshal(m[k], &b) == nil {
		return b
	}
	var n int
	_ = json.Unmarshal(m[k], &n)
	return n != 0
}
func path(v string) string { return url.PathEscape(v) }

type HTTP struct{ Client *http.Client }

func (h HTTP) request(ctx context.Context, method, endpoint string, creds Credentials, body any, etag string) ([]byte, http.Header, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(Raw(body))
	}
	req, e := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if e != nil {
		return nil, nil, e
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if creds.Username != "" {
		req.SetBasicAuth(creds.Username, creds.Token)
	} else {
		req.Header.Set("Authorization", "Bearer "+creds.Token)
	}
	if etag != "" {
		req.Header.Set("If-Match", etag)
	}
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	resp, e := client.Do(req)
	write := method != "GET"
	if e != nil {
		state := "retryable"
		if write {
			state = "delivery_unknown"
		}
		return nil, nil, &Failure{State: state}
	}
	defer resp.Body.Close()
	b, e := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
	if e != nil || len(b) > 8<<20 {
		return nil, nil, &Failure{State: map[bool]string{true: "delivery_unknown", false: "retryable"}[write]}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.Header, classify(resp.StatusCode, write)
	}
	if resp.StatusCode == 202 {
		return nil, resp.Header, &Failure{State: "in_progress", Status: 202}
	}
	return b, resp.Header, nil
}

// SafeClient pins every connection to an approved resolved address. Redirects
// are refused so credentials cannot cross origins or bypass host approval.
func SafeClient(allowedPrivateHosts []string) *http.Client {
	allowed := map[string]bool{}
	for _, h := range allowedPrivateHosts {
		allowed[strings.ToLower(h)] = true
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		for _, ip := range ips {
			if !ip.IP.IsGlobalUnicast() || ip.IP.IsLinkLocalUnicast() {
				return nil, fmt.Errorf("provider destination denied")
			}
			if (ip.IP.IsPrivate() || ip.IP.IsLoopback()) && !allowed[strings.ToLower(host)] {
				return nil, fmt.Errorf("provider private host requires operator approval")
			}
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("provider host has no addresses")
		}
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}
	return &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func Endpoint(v string) error {
	u, e := url.Parse(v)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return c.Fail("invalid_input", "Provider endpoint must be an HTTPS origin/base path")
	}
	return nil
}
