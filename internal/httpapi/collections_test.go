package httpapi

import (
	"encoding/json"
	"github.com/nick1udwig/pebble-agent/internal/collectionstore"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCollectionsRequireAuthAndWorkWithoutAgent(t *testing.T) {
	store, e := collectionstore.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	server := New(Config{Token: "secret", Collections: store})
	request := httptest.NewRequest("GET", "/v1/sync/info", nil)
	w := httptest.NewRecorder()
	server.ServeHTTP(w, request)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	request.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	server.ServeHTTP(w, request)
	if w.Code != 200 || !strings.Contains(w.Body.String(), store.ServerID) {
		t.Fatal(w.Code, w.Body.String())
	}
	request = httptest.NewRequest("POST", "/v1/sync/clients", strings.NewReader("{}"))
	request.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	server.ServeHTTP(w, request)
	var response map[string]any
	if e = json.Unmarshal(w.Body.Bytes(), &response); e != nil || response["client_id"] == "" {
		t.Fatal(response, e)
	}
}

func TestManagementURLAndProviderRequireAuthenticatedPhone(t *testing.T) {
	calls := 0
	s := New(Config{Token: "t", IntegrationTicket: func(base, provider, collection string) (string, error) {
		calls++
		if base != "https://example.test/codey" || provider != "todoist" {
			t.Fatal(base, provider)
		}
		return base + "/integrations?ticket=test", nil
	}})
	for _, authenticated := range []bool{false, true} {
		r := httptest.NewRequest("POST", "/v1/integration-sessions", strings.NewReader(`{"public_url":"https://example.test/codey","provider":"todoist"}`))
		if authenticated {
			r.Header.Set("Authorization", "Bearer t")
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if authenticated && w.Code != 200 || !authenticated && w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}

func TestInlineSetupSessionIssuanceRequiresPhoneBearer(t *testing.T) {
	calls := 0
	s := New(Config{Token: "phone", IntegrationSetup: func(base string) (map[string]string, error) {
		calls++
		return map[string]string{"url": base + "/integrations/setup-api", "token": "temporary"}, nil
	}})
	for _, token := range []string{"", "temporary", "phone"} {
		r := httptest.NewRequest("POST", "/v1/integration-setup-sessions", strings.NewReader(`{"public_url":"https://server.test"}`))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if token == "phone" && w.Code != 200 || token != "phone" && w.Code != 401 {
			t.Fatal(token, w.Code)
		}
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}

func TestSnapshotCanReturnFirstPageInOneRequest(t *testing.T) {
	store, err := collectionstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := New(Config{Token: "secret", Collections: store})
	for _, body := range []string{`{"collection_id":"col_note","state":"active","limit":8}`, `{"collection_id":"col_note","state":"active"}`} {
		r := httptest.NewRequest("POST", "/v1/sync/snapshots", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer secret")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var page collectionstore.Page
		if err = json.Unmarshal(w.Body.Bytes(), &page); err != nil || w.Code != 200 || page.SnapshotID == "" || page.Records == nil {
			t.Fatal(w.Code, w.Body.String(), err)
		}
		if strings.Contains(body, "limit") && !page.Complete {
			t.Fatal("empty first page should be complete", page)
		}
	}
}
