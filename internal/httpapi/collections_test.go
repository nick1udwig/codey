package httpapi

import (
	"encoding/json"
	c "github.com/nick1udwig/pebble-agent/internal/collections"
	"github.com/nick1udwig/pebble-agent/internal/collectionstore"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckLookupAndHistoryRoutes(t *testing.T) {
	store, e := collectionstore.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	client, e := store.Enroll()
	if e != nil {
		t.Fatal(e)
	}
	recordID := "rec:" + client + ":1"
	batch := c.Batch{Version: 1, ServerID: store.ServerID, Epoch: store.Epoch, ClientID: client, Operations: []c.Operation{{ID: "op:" + client + ":1", IngressID: "check-route-1", Sequence: "1", CollectionID: "col_check", Generation: "1", RecordID: recordID, Type: "check.create", Payload: map[string]json.RawMessage{"title": json.RawMessage(`"baby"`)}}}}
	if _, e = store.Mutate(batch); e != nil {
		t.Fatal(e)
	}
	server := New(Config{Token: "secret", Collections: store})
	get := func(path string, auth bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		if auth {
			r.Header.Set("Authorization", "Bearer secret")
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	if w := get("/v1/checks/lookup?name=BABY", false); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := get("/v1/checks/lookup?name=BABY", true); w.Code != 200 || !strings.Contains(w.Body.String(), recordID) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := get("/v1/checks/"+recordID+"/history?limit=8", true); w.Code != 200 || !strings.Contains(w.Body.String(), `"occurrences":[]`) {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestCollectionsRequireAuthAndWorkWithoutAgent(t *testing.T) {
	store, e := collectionstore.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	wakes := 0
	server := New(Config{Token: "secret", Collections: store, WakeCollections: func() { wakes++ }})
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
	client := response["client_id"].(string)
	batch := map[string]any{"protocol_version": 1, "server_instance_id": store.ServerID, "store_epoch": store.Epoch, "client_id": client,
		"operations": []any{map[string]any{"id": "op:" + client + ":1", "sequence": "1", "ingress_id": "fixture", "record_id": "rec:" + client + ":1", "collection_id": "col_note", "binding_generation": "1", "type": "note.create", "payload": map[string]string{"title": "Note", "body": "Body"}}}}
	raw, _ := json.Marshal(batch)
	request = httptest.NewRequest("POST", "/v1/sync/mutations", strings.NewReader(string(raw)))
	request.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	server.ServeHTTP(w, request)
	if w.Code != 200 || wakes != 1 {
		t.Fatal(w.Code, w.Body.String(), wakes)
	}
	request = httptest.NewRequest("POST", "/v1/sync/mutations", strings.NewReader("{}"))
	request.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	server.ServeHTTP(w, request)
	if w.Code == 200 || wakes != 1 {
		t.Fatal("invalid batch woke worker")
	}
}

func TestTokenlessCollectionsRequireExplicitOptIn(t *testing.T) {
	store, err := collectionstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, tc := range []struct {
		name   string
		config Config
		want   int
	}{
		{"default", Config{Collections: store}, 401},
		{"opted in", Config{Collections: store, AllowUnauthenticatedCollections: true}, 200},
		{"token still required", Config{Collections: store, Token: "secret", AllowUnauthenticatedCollections: true}, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := New(tc.config)
			request := httptest.NewRequest("GET", "/v1/sync/info", nil)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("collection status = %d, want %d", response.Code, tc.want)
			}
			if tc.name == "opted in" {
				request = httptest.NewRequest("GET", "/v1/providers", nil)
				response = httptest.NewRecorder()
				server.ServeHTTP(response, request)
				if response.Code != 401 {
					t.Fatalf("integration management status = %d, want 401", response.Code)
				}
			}
		})
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
