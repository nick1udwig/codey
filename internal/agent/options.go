package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/nick1udwig/pebble-agent/internal/appserver"
	"github.com/nick1udwig/pebble-agent/internal/pam"
)

// Settings with different tool permissions use separate threads. Thread-level
// tool configuration cannot safely be replaced with only turn/start overrides.
func (agent *Agent) sessionKey(session string, options pam.BackendOptions) string {
	options.FastMode = false
	options.Model = ""
	options.Effort = ""
	data, _ := json.Marshal(struct {
		Options   pam.BackendOptions
		Workspace string
	}{options, agent.config.Workspace})
	return fmt.Sprintf("%s:policy:%x", session, sha256.Sum256(data))
}

func approvalOptions(options pam.BackendOptions) (string, string) {
	if options.AutoReview {
		return "on-request", "auto_review"
	}
	return "never", "user"
}

func (agent *Agent) threadOptions(ctx context.Context, connection *appserver.Connection, options pam.BackendOptions) (map[string]any, error) {
	// Explicitly disable inherited connectors/plugins: their out-of-process tools
	// do not obey the local command sandbox. The settings here cover local tools
	// and built-in web search, not an arbitrary external MCP server's privileges.
	var effective struct {
		Config map[string]any `json:"config"`
	}
	if err := connection.Request(ctx, "config/read", map[string]any{"includeLayers": false, "cwd": agent.config.Workspace}, &effective); err != nil {
		return nil, fmt.Errorf("read Codex tool configuration: %w", err)
	}
	config := map[string]any{
		"web_search":                       options.WebSearch,
		"features.shell_tool":              options.ShellAccess,
		"features.apps":                    false,
		"features.multi_agent":             false,
		"features.js_repl":                 false,
		"features.memories":                false,
		"project_doc_max_bytes":            0,
		"shell_environment_policy.inherit": "core",
	}
	for _, section := range []string{"mcp_servers", "plugins"} {
		disabled := map[string]any{}
		if entries, ok := effective.Config[section].(map[string]any); ok {
			for name := range entries {
				disabled[name] = map[string]any{"enabled": false}
			}
		}
		config[section] = disabled
	}
	files := map[string]any{":minimal": "read"}
	switch options.FileAccess {
	case "read-only":
		files = map[string]any{"/": "read"}
	case "workspace-write":
		files = map[string]any{"/": "read", agent.config.Workspace: "write"}
	}
	config["permissions"] = map[string]any{"pebble": map[string]any{
		"filesystem": files, "network": map[string]any{"enabled": options.NetworkAccess},
	}}
	policy, reviewer := approvalOptions(options)
	model := options.Model
	if model == "" {
		model = agent.config.Model
	}
	return map[string]any{
		"approvalPolicy": policy, "approvalsReviewer": reviewer,
		"baseInstructions": baseInstructions, "developerInstructions": developerInstructions,
		"cwd": agent.config.Workspace, "model": model, "permissions": "pebble", "config": config,
	}, nil
}

type Model struct {
	Model                     string `json:"model"`
	DisplayName               string `json:"displayName"`
	DefaultReasoningEffort    string `json:"defaultReasoningEffort"`
	SupportedReasoningEfforts []struct {
		ReasoningEffort string `json:"reasoningEffort"`
		Description     string `json:"description"`
	} `json:"supportedReasoningEfforts"`
}

type ModelCatalog struct {
	Models        []Model `json:"models"`
	DefaultModel  string  `json:"defaultModel"`
	DefaultEffort string  `json:"defaultEffort"`
}

func (agent *Agent) Models(ctx context.Context) (ModelCatalog, error) {
	connection, _, _, err := agent.client.Connection(ctx)
	if err != nil {
		return ModelCatalog{}, err
	}
	catalog := ModelCatalog{DefaultModel: agent.config.Model, DefaultEffort: agent.config.Effort, Models: []Model{}}
	cursor := ""
	for page := 0; page < 20; page++ {
		params := map[string]any{"limit": 100, "includeHidden": false}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var result struct {
			Data       []Model `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if err := connection.Request(ctx, "model/list", params, &result); err != nil {
			return catalog, err
		}
		catalog.Models = append(catalog.Models, result.Data...)
		if result.NextCursor == nil || *result.NextCursor == "" {
			return catalog, nil
		}
		if *result.NextCursor == cursor {
			return catalog, fmt.Errorf("Codex model catalog repeated its cursor")
		}
		cursor = *result.NextCursor
	}
	return catalog, fmt.Errorf("Codex model catalog exceeded page limit")
}

func (agent *Agent) modelOptions(ctx context.Context, options pam.BackendOptions) (string, string, error) {
	model, effort := options.Model, options.Effort
	if model == "" {
		model = agent.config.Model
	}
	if options.Model == "" && effort == "" {
		return model, agent.config.Effort, nil
	}
	catalog, err := agent.Models(ctx)
	if err != nil {
		return "", "", fmt.Errorf("load Codex models: %w", err)
	}
	for _, entry := range catalog.Models {
		if entry.Model != model {
			continue
		}
		if effort == "" {
			effort = entry.DefaultReasoningEffort
		}
		for _, supported := range entry.SupportedReasoningEfforts {
			if supported.ReasoningEffort == effort {
				return model, effort, nil
			}
		}
		return "", "", fmt.Errorf("model %s does not support effort %s", model, effort)
	}
	return "", "", fmt.Errorf("Codex model %s is unavailable", model)
}
