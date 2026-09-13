package agent

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/nick1udwig/pebble-agent/internal/appserver"
)

type statusConnector struct{ s *statusSession }

func (c statusConnector) Name() string                                    { return "status-fixture" }
func (c statusConnector) Open(context.Context) (appserver.Session, error) { return c.s, nil }

type statusSession struct {
	*scriptedSession
	t                   *testing.T
	failRead, failQuota bool
	threadState         string
}

func (s *statusSession) Write(_ context.Context, payload []byte) error {
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params map[string]any  `json:"params"`
	}
	_ = json.Unmarshal(payload, &m)
	if m.Method == "initialized" {
		return nil
	}
	var result any = map[string]any{}
	failed := false
	switch m.Method {
	case "initialize":
	case "account/rateLimits/read":
		failed = s.failQuota
		result = map[string]any{"rateLimitsByLimitId": map[string]any{"codex": map[string]any{"primary": map[string]any{"usedPercent": 25}, "secondary": map[string]any{"usedPercent": 60}}}}
	case "thread/loaded/list":
		if m.Params["cursor"] == "second" {
			result = map[string]any{"data": []string{"c"}}
		} else {
			result = map[string]any{"data": []string{"a", "b"}, "nextCursor": "second"}
		}
	case "thread/read":
		if m.Params["includeTurns"] != false {
			s.t.Error("status requested conversation contents")
		}
		failed = s.failRead
		state := "active"
		if s.threadState != "" {
			state = s.threadState
		}
		if m.Params["threadId"] == "b" {
			state = "idle"
		}
		result = map[string]any{"thread": map[string]any{"status": map[string]any{"type": state}}}
	default:
		s.t.Errorf("unexpected request %s", m.Method)
		failed = true
	}
	var data []byte
	if failed {
		data, _ = json.Marshal(map[string]any{"id": m.ID, "error": map[string]any{"code": -1, "message": "unavailable"}})
	} else {
		data, _ = json.Marshal(map[string]any{"id": m.ID, "result": result})
	}
	s.reads <- data
	return nil
}
func TestDashboardStatusCurrentAPI(t *testing.T) {
	for _, tc := range []struct{ read, quota bool }{{false, false}, {true, false}, {false, true}} {
		s := &statusSession{scriptedSession: (&scriptedServer{}).session(), t: t, failRead: tc.read, failQuota: tc.quota}
		client := appserver.NewClient(appserver.ClientConfig{Connectors: []appserver.Connector{statusConnector{s}}})
		a := New(client, nil, Config{})
		status, err := a.DashboardStatus(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if tc.quota {
			if status.RemainingPercent != nil {
				t.Fatal(status)
			}
		} else if status.RemainingPercent == nil || *status.RemainingPercent != 40 {
			t.Fatal(status)
		}
		if tc.read {
			if status.ActiveThreads != nil || status.State != "unknown" {
				t.Fatal(status)
			}
		} else if status.ActiveThreads == nil || *status.ActiveThreads != 2 || status.State != "working" {
			t.Fatal(status)
		}
		client.Close()
	}
}
func TestRemainingQuota(t *testing.T) {
	if remainingQuota(rateSnapshot{}) != nil {
		t.Fatal("missing quota must be unknown")
	}
	for _, tc := range []struct{ used, want int }{{0, 100}, {100, 0}, {130, 0}, {-5, 100}} {
		if got := *remainingQuota(rateSnapshot{Primary: &rateWindow{tc.used}}); got != tc.want {
			t.Fatal(got)
		}
	}
}

func TestDashboardIdleAndError(t *testing.T) {
	for _, state := range []string{"idle", "systemError"} {
		s := &statusSession{scriptedSession: (&scriptedServer{}).session(), t: t, threadState: state}
		client := appserver.NewClient(appserver.ClientConfig{Connectors: []appserver.Connector{statusConnector{s}}})
		a := New(client, nil, Config{})
		status, err := a.DashboardStatus(context.Background())
		want := "idle"
		if state == "systemError" {
			want = "error"
		}
		if err != nil || status.State != want || status.ActiveThreads == nil || *status.ActiveThreads != 0 {
			t.Fatal(status, err)
		}
		client.Close()
	}
}
