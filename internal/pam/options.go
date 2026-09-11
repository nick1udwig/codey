package pam

import (
	"fmt"
	"regexp"
)

// BackendOptions is an allowlist, not a general Codex configuration channel.
// It is transported separately from the model-facing user request.
type BackendOptions struct {
	Model         string `json:"model"`
	Effort        string `json:"effort"`
	WebSearch     string `json:"webSearch"`
	FileAccess    string `json:"fileAccess"`
	NetworkAccess bool   `json:"networkAccess"`
	ShellAccess   bool   `json:"shellAccess"`
	AutoReview    bool   `json:"autoReview"`
}

var optionIdentifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$`)

func ParseBackendOptions(attrs map[string]string) (BackendOptions, error) {
	o := BackendOptions{WebSearch: "disabled", FileAccess: "none"}
	for k, v := range attrs {
		switch k {
		case "model", "effort":
			if v != "" && !optionIdentifier.MatchString(v) {
				return o, fmt.Errorf("invalid Codex %s", k)
			}
			if k == "model" {
				o.Model = v
			} else {
				o.Effort = v
			}
		case "web_search":
			if v != "disabled" && v != "cached" && v != "live" {
				return o, fmt.Errorf("invalid web_search")
			}
			o.WebSearch = v
		case "file_access":
			if v != "none" && v != "read-only" && v != "workspace-write" {
				return o, fmt.Errorf("invalid file_access")
			}
			o.FileAccess = v
		case "network_access", "shell_access", "auto_review":
			if v != "true" && v != "false" {
				return o, fmt.Errorf("%s must be true or false", k)
			}
			switch k {
			case "network_access":
				o.NetworkAccess = v == "true"
			case "shell_access":
				o.ShellAccess = v == "true"
			case "auto_review":
				o.AutoReview = v == "true"
			}
		default:
			return o, fmt.Errorf("unsupported backend option %s", k)
		}
	}
	return o, nil
}
