package agent

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
	readsCount          atomic.Int32
	quotaStarted        chan struct{}
	quotaRelease        chan struct{}
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
		if s.quotaStarted != nil {
			close(s.quotaStarted)
			<-s.quotaRelease
		}
		failed = s.failQuota
		result = map[string]any{"rateLimitsByLimitId": map[string]any{"codex": map[string]any{"primary": map[string]any{"usedPercent": 25}, "secondary": map[string]any{"usedPercent": 60}}}}
	case "thread/loaded/list":
		if m.Params["cursor"] == "second" {
			result = map[string]any{"data": []string{"c"}}
		} else {
			result = map[string]any{"data": []string{"a", "b"}, "nextCursor": "second"}
		}
	case "thread/read":
		s.readsCount.Add(1)
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

func TestStatusSharesScanAndCancellationDoesNotCancelOtherCallers(t *testing.T) {
	s := &statusSession{scriptedSession: (&scriptedServer{}).session(), t: t, quotaStarted: make(chan struct{}), quotaRelease: make(chan struct{})}
	client := appserver.NewClient(appserver.ClientConfig{Connectors: []appserver.Connector{statusConnector{s}}})
	defer client.Close()
	a := New(client, nil, Config{})
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, err := a.DashboardStatus(ctx); first <- err }()
	<-s.quotaStarted
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := a.DashboardStatus(context.Background())
			if err != nil || v.ActiveThreads == nil || *v.ActiveThreads != 2 {
				t.Errorf("status: %+v, %v", v, err)
			}
		}()
	}
	close(s.quotaRelease)
	wg.Wait()
	if s.readsCount.Load() != 3 {
		t.Fatal("duplicate thread scans", s.readsCount.Load())
	}
	v, err := a.DashboardStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	*v.ActiveThreads = 99
	v, _ = a.DashboardStatus(context.Background())
	if *v.ActiveThreads != 2 {
		t.Fatal("caller mutated cache")
	}
	a.statusMu.Lock()
	a.statusExpires = time.Time{}
	a.statusMu.Unlock()
	s.quotaStarted = nil
	if _, err = a.DashboardStatus(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.readsCount.Load() != 6 {
		t.Fatal("expired cache reused")
	}
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
