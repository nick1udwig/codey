package agent

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/nick1udwig/pebble-agent/internal/appserver"
	"github.com/nick1udwig/pebble-agent/internal/pam"
	"github.com/nick1udwig/pebble-agent/internal/state"
)

//go:embed prompt.md
var developerInstructions string

const baseInstructions = "You are codey, a concise general assistant for a small watch. Follow the developer instructions exactly. Use only the tools permitted by the session configuration when needed. Return the final answer only as PAM."

type Config struct {
	SkillPath string
	Model     string
	Effort    string
	Workspace string
	Timeout   time.Duration
	Logger    *slog.Logger
}

type Agent struct {
	client *appserver.Client
	store  *state.Store
	config Config

	loadedMu         sync.Mutex
	loaded           map[string]struct{}
	loadedGeneration uint64
	locks            sessionLocks
	statusMu         sync.Mutex
	statusFlight     *statusFlight
	statusCache      DashboardStatus
	statusGeneration uint64
	statusExpires    time.Time
}

func New(client *appserver.Client, store *state.Store, config Config) *Agent {
	if config.Model == "" {
		config.Model = "gpt-5.6-luna"
	}
	if config.Effort == "" {
		config.Effort = "xhigh"
	}

	return &Agent{client: client, store: store, config: config, loaded: make(map[string]struct{})}
}

func (agent *Agent) Respond(ctx context.Context, request pam.Request, emit func([]byte) error) error {
	stream := pam.NewOutputStream(emit)
	err := agent.respond(ctx, request, stream)
	if err == nil {
		err = stream.Finish()
	}
	if err != nil {
		if emitErr := stream.EmitError(fmt.Errorf("Request failed: %w", err)); emitErr != nil {
			return fmt.Errorf("%w (also failed to send PAM error: %v)", err, emitErr)
		}
	}
	return err
}

func (agent *Agent) respond(parent context.Context, request pam.Request, stream *pam.OutputStream) error {
	release, err := agent.locks.acquire(parent, request.Session)
	if err != nil {
		return err
	}
	defer release()
	ctx := parent
	if agent.config.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(parent, agent.config.Timeout)
		defer cancel()
	}
	connection, generation, _, err := agent.client.Connection(ctx)
	if err != nil {
		return err
	}
	agent.loadedMu.Lock()
	agent.observeGenerationLocked(generation)
	agent.loadedMu.Unlock()
	model, effort, err := agent.modelOptions(ctx, request.Backend)
	if err != nil {
		return err
	}
	request.Backend.Model = model
	sessionKey := agent.sessionKey(request.Session, request.Backend)
	threadID, err := agent.store.Thread(sessionKey)
	if err != nil {
		return err
	}
	if threadID == "" {
		threadID, err = agent.startThread(ctx, connection, generation, sessionKey, request.Backend)
	} else if !agent.isLoaded(threadID, generation) {
		err = agent.resumeThread(ctx, connection, generation, threadID, request.Backend)
		if err != nil && threadMissing(err) {
			if clearErr := agent.store.Set(sessionKey, ""); clearErr != nil {
				return clearErr
			}
			threadID, err = agent.startThread(ctx, connection, generation, sessionKey, request.Backend)
		}
	}
	if err != nil {
		return err
	}
	return agent.runTurn(ctx, connection, threadID, request.Raw, model, effort, request.Backend, stream)
}

func (agent *Agent) startThread(ctx context.Context, connection *appserver.Connection, generation uint64, session string, options pam.BackendOptions) (string, error) {
	var response struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	params, err := agent.threadOptions(ctx, connection, options)
	if err != nil {
		return "", err
	}
	params["ephemeral"] = false
	params["serviceName"] = "codey"
	err = connection.Request(ctx, "thread/start", params, &response)
	if err != nil {
		return "", fmt.Errorf("start Codex thread: %w", err)
	}
	if response.Thread.ID == "" {
		return "", errors.New("app-server returned an empty thread id")
	}
	if err := agent.store.Set(session, response.Thread.ID); err != nil {
		return "", err
	}
	agent.markLoaded(response.Thread.ID, generation)
	return response.Thread.ID, nil
}

func (agent *Agent) resumeThread(ctx context.Context, connection *appserver.Connection, generation uint64, threadID string, options pam.BackendOptions) error {
	var response map[string]any
	params, err := agent.threadOptions(ctx, connection, options)
	if err != nil {
		return err
	}
	params["excludeTurns"] = true
	params["threadId"] = threadID
	err = connection.Request(ctx, "thread/resume", params, &response)
	if err != nil {
		return fmt.Errorf("resume Codex thread: %w", err)
	}
	agent.markLoaded(threadID, generation)
	return nil
}

func (agent *Agent) runTurn(ctx context.Context, connection *appserver.Connection, threadID, request, model, effort string, options pam.BackendOptions, stream *pam.OutputStream) error {
	subscription, err := connection.Subscribe(threadID)
	if err != nil {
		return err
	}
	defer subscription.Close()
	var response struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	prompt := "Respond to this watch request. Return only one PAM document.\n\n" + request
	// Inherit the thread's resolved permissions snapshot. Re-sending the named
	// profile here makes app-server resolve it against disk config, where our
	// per-thread profile does not exist. Permission changes use another thread.
	tier := "default"
	if options.FastMode {
		tier = "fast"
	}
	policy, reviewer := approvalOptions(options)
	err = connection.Request(ctx, "turn/start", map[string]any{
		"approvalPolicy":     policy,
		"approvalsReviewer":  reviewer,
		"serviceTierForTurn": tier,
		"cwd":                agent.config.Workspace,
		"effort":             effort,
		"input":              []map[string]any{{"type": "text", "text": prompt}},
		"model":              model,
		"threadId":           threadID,
	}, &response)
	if err != nil {
		return fmt.Errorf("start Codex turn: %w", err)
	}
	if response.Turn.ID == "" {
		return errors.New("app-server returned an empty turn id")
	}
	turnID := response.Turn.ID
	processor := newTurnProcessor(turnID, stream)
	for {
		select {
		case <-ctx.Done():
			agent.interrupt(connection, threadID, turnID)
			return ctx.Err()
		case notification, ok := <-subscription.C:
			if !ok {
				return connection.Err()
			}
			completed, err := processor.Accept(notification)
			if err != nil {
				agent.interrupt(connection, threadID, turnID)
				return err
			}
			if completed {
				return nil
			}
		}
	}
}

func (agent *Agent) interrupt(connection *appserver.Connection, threadID, turnID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := connection.Request(ctx, "turn/interrupt", map[string]string{"threadId": threadID, "turnId": turnID}, nil); err != nil && agent.config.Logger != nil {
		agent.config.Logger.Debug("failed to interrupt Codex turn", "error", err)
	}
}

func (agent *Agent) isLoaded(threadID string, generation uint64) bool {
	agent.loadedMu.Lock()
	defer agent.loadedMu.Unlock()
	agent.observeGenerationLocked(generation)
	_, loaded := agent.loaded[threadID]
	return generation == agent.loadedGeneration && loaded
}

func (agent *Agent) markLoaded(threadID string, generation uint64) {
	agent.loadedMu.Lock()
	agent.observeGenerationLocked(generation)
	if generation == agent.loadedGeneration {
		agent.loaded[threadID] = struct{}{}
	}
	agent.loadedMu.Unlock()
}

// Generations increase monotonically. Late replies from a replaced connection
// must never restore obsolete bookkeeping or evict the current generation.
func (agent *Agent) observeGenerationLocked(generation uint64) {
	if generation > agent.loadedGeneration {
		agent.loadedGeneration = generation
		agent.loaded = make(map[string]struct{})
	}
}

func threadMissing(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "thread not found") || strings.Contains(message, "unknown thread")
}

type itemState struct {
	phase    string
	typeName string
	started  bool
	hasText  bool
	pending  []string
}

type turnProcessor struct {
	turnID string
	stream *pam.OutputStream
	items  map[string]*itemState
}

func newTurnProcessor(turnID string, stream *pam.OutputStream) *turnProcessor {
	return &turnProcessor{turnID: turnID, stream: stream, items: make(map[string]*itemState)}
}

func (processor *turnProcessor) Accept(notification appserver.Notification) (bool, error) {
	switch notification.Method {
	case "item/started", "item/completed":
		var params struct {
			TurnID string `json:"turnId"`
			Item   struct {
				ID    string  `json:"id"`
				Type  string  `json:"type"`
				Phase *string `json:"phase"`
				Text  string  `json:"text"`
			} `json:"item"`
		}
		if err := json.Unmarshal(notification.Params, &params); err != nil {
			return false, err
		}
		if params.TurnID != processor.turnID || params.Item.ID == "" {
			return false, nil
		}
		item := processor.item(params.Item.ID)
		item.started = true
		item.typeName = params.Item.Type
		if params.Item.Phase != nil {
			item.phase = *params.Item.Phase
		}
		if item.typeName == "agentMessage" && item.phase != "commentary" {
			for _, delta := range item.pending {
				if err := processor.push(item, delta); err != nil {
					return false, err
				}
			}
			item.pending = nil
			if notification.Method == "item/completed" && !item.hasText && params.Item.Text != "" {
				if err := processor.push(item, params.Item.Text); err != nil {
					return false, err
				}
			}
		} else if item.phase == "commentary" {
			item.pending = nil
		}
	case "item/agentMessage/delta":
		var params struct {
			TurnID string `json:"turnId"`
			ItemID string `json:"itemId"`
			Delta  string `json:"delta"`
		}
		if err := json.Unmarshal(notification.Params, &params); err != nil {
			return false, err
		}
		if params.TurnID != processor.turnID || params.ItemID == "" || params.Delta == "" {
			return false, nil
		}
		item := processor.item(params.ItemID)
		if !item.started {
			item.pending = append(item.pending, params.Delta)
		} else if item.phase != "commentary" {
			if err := processor.push(item, params.Delta); err != nil {
				return false, err
			}
		}
	case "turn/completed":
		var params struct {
			Turn struct {
				ID     string `json:"id"`
				Status string `json:"status"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"turn"`
		}
		if err := json.Unmarshal(notification.Params, &params); err != nil {
			return false, err
		}
		if params.Turn.ID != processor.turnID {
			return false, nil
		}
		if params.Turn.Status != "completed" {
			message := "Codex turn " + params.Turn.Status
			if params.Turn.Error != nil && params.Turn.Error.Message != "" {
				message = params.Turn.Error.Message
			}
			return false, errors.New(message)
		}
		return true, nil
	case "error":
		var params struct {
			TurnID string `json:"turnId"`
			Error  struct {
				Message string `json:"message"`
			} `json:"error"`
			WillRetry bool `json:"willRetry"`
		}
		if err := json.Unmarshal(notification.Params, &params); err == nil && params.TurnID == processor.turnID && !params.WillRetry {
			if params.Error.Message == "" {
				params.Error.Message = "Codex turn failed"
			}
			return false, errors.New(params.Error.Message)
		}
	}
	return false, nil
}

func (processor *turnProcessor) item(id string) *itemState {
	item := processor.items[id]
	if item == nil {
		item = &itemState{}
		processor.items[id] = item
	}
	return item
}

func (processor *turnProcessor) push(item *itemState, delta string) error {
	if delta != "" {
		item.hasText = true
	}
	return processor.stream.Push(delta)
}
