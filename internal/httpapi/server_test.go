package httpapi

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
	"github.com/nick1udwig/pebble-agent/internal/pam"
)

type responderStub struct {
	calls atomic.Int32
}

func (responder *responderStub) Respond(_ context.Context, _ pam.Request, emit func([]byte) error) error {
	responder.calls.Add(1)
	for _, line := range []string{
		"pam version=1\n",
		"screen id=answer layout=text title=Answer\n",
		"  text id=body value=Hello\n",
		"done\n",
	} {
		if err := emit([]byte(line)); err != nil {
			return err
		}
	}
	return nil
}

func TestHTTPAgentAuthenticationAndPAMResponse(t *testing.T) {
	responder := &responderStub{}
	server := httptest.NewServer(New(Config{Responder: responder, Token: "secret"}))
	defer server.Close()
	body := requestDocument("")

	unauthorized, err := http.Post(server.URL+"/v1/agent", pamContentType, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	_ = unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized || responder.calls.Load() != 0 {
		t.Fatalf("unauthorized status=%d calls=%d", unauthorized.StatusCode, responder.calls.Load())
	}

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/agent", strings.NewReader(body))
	request.Header.Set("Content-Type", pamContentType)
	request.Header.Set("Authorization", "Bearer secret")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || responder.calls.Load() != 1 {
		t.Fatalf("status=%d calls=%d", response.StatusCode, responder.calls.Load())
	}
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "text/x-pebble-agent-markup") {
		t.Fatalf("content type %q", response.Header.Get("Content-Type"))
	}
	if _, err := pam.Decode(payload, pam.MaxOutputBytes); err != nil {
		t.Fatalf("invalid response PAM: %v", err)
	}
}

func TestHTTPAgentRejectsMalformedPAMBeforeCallingResponder(t *testing.T) {
	responder := &responderStub{}
	request := httptest.NewRequest(http.MethodPost, "/v1/agent", strings.NewReader("not pam\n"))
	request.Header.Set("Content-Type", pamContentType)
	recorder := httptest.NewRecorder()
	New(Config{Responder: responder}).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || responder.calls.Load() != 0 {
		t.Fatalf("status=%d calls=%d", recorder.Code, responder.calls.Load())
	}
	if _, err := pam.Decode(recorder.Body.Bytes(), pam.MaxOutputBytes); err != nil {
		t.Fatalf("bad-request body is not PAM: %v", err)
	}
}

func TestWebSocketAgentUsesPAMSubprotocolAndNestedBearer(t *testing.T) {
	responder := &responderStub{}
	httpServer := httptest.NewServer(New(Config{Responder: responder, Token: "secret"}))
	defer httpServer.Close()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/v1/agent"
	ctx := context.Background()
	connection, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{"pam.v1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if err := connection.Write(ctx, websocket.MessageText, []byte(requestDocument("secret"))); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				break
			}
			t.Fatal(err)
		}
		output.Write(payload)
	}
	if responder.calls.Load() != 1 {
		t.Fatalf("calls=%d", responder.calls.Load())
	}
	if _, err := pam.Decode(output.Bytes(), pam.MaxOutputBytes); err != nil {
		t.Fatalf("invalid WebSocket PAM: %v\n%s", err, output.String())
	}
}

func requestDocument(token string) string {
	source := "pam version=1\nrequest id=9 protocol=pam/1 session=test-session\n  input kind=dictation text=hello action= element= value=\n  context screen= layout= selected=\n  device platform=emery model=pebble_time_2 shape=rect touch=true\n"
	if token != "" {
		source += "  auth bearer=" + token + "\n"
	}
	return source + "done\n"
}
