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
