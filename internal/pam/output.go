package pam

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	MaxOutputBytes = 128 << 10
	MaxOutputNodes = 96
	MaxElements    = 48
)

var layouts = set("text", "list", "menu", "grid", "card", "progress", "form", "choice", "modal")
var elements = set("section", "item", "text", "metric", "progress", "field", "choice", "action", "bind", "image", "spacer", "hotspot")
var inputs = set("up", "select", "down", "back", "tap", "swipe-left", "swipe-right", "swipe-up", "swipe-down")
var capabilityCommands = map[string]map[string]bool{
	"todo":      set("add", "list", "archive"),
	"calendar":  set("add", "list"),
	"note":      set("add", "edit", "list"),
	"timer":     set("start", "pause", "resume", "cancel", "show", "list", "ack", "cancel_all"),
	"stopwatch": set("start", "pause", "resume", "lap", "reset", "show"),
	"weather":   set("current", "show"),
	"reminder":  set("schedule", "show", "list", "cancel", "ack", "cancel_all"),
	"alarm":     set("schedule", "show", "list", "cancel", "ack", "cancel_all"),
}

type OutputValidator struct {
	decoder *Decoder

	elements     map[string]bool
	elementCount int
	nodeCount    int
	sawEffect    bool
	screenOpen   bool
	totalBytes   int
}

func NewOutputValidator() *OutputValidator {
	return &OutputValidator{decoder: NewDecoder(), elements: make(map[string]bool)}
}

// Accept validates one complete line without its trailing newline. It returns
// false for blank lines and comments, which callers can safely discard.
func (validator *OutputValidator) Accept(source string) (bool, error) {
	if strings.HasSuffix(source, "\r") {
		source = strings.TrimSuffix(source, "\r")
	}
	validator.totalBytes += len(source) + 1
	if validator.totalBytes > MaxOutputBytes {
		return false, fmt.Errorf("agent output exceeds %d bytes", MaxOutputBytes)
	}
	node, err := validator.decoder.Accept(source)
	if err != nil {
		return false, err
	}
	if node == nil {
		return false, nil
	}
	validator.nodeCount++
	if validator.nodeCount > MaxOutputNodes {
		return false, fmt.Errorf("agent output exceeds %d PAM nodes", MaxOutputNodes)
	}
	if err := validator.acceptNode(node); err != nil {
		return false, err
	}
	return true, nil
}

func (validator *OutputValidator) Finish() (bool, error) {
	if err := validator.decoder.Finish(); err != nil {
		return false, err
	}
	if !validator.sawEffect {
		return false, errors.New("agent output did not contain a screen, capability, or error")
	}
	return validator.screenOpen, nil
}

func (validator *OutputValidator) acceptNode(node *Node) error {
	if node.Kind == "pam" {
		return nil
	}
	switch node.Kind {
	case "screen":
		if node.Depth != 0 {
			return nodeError(node, "screen must be a root node")
		}
		if node.Attrs["id"] == "" {
			return nodeError(node, "screen requires id")
		}
		if err := boundedAttribute(node, "id", 31); err != nil {
			return err
		}
		if !layouts[node.Attrs["layout"]] {
			return nodeError(node, "unsupported screen layout "+node.Attrs["layout"])
		}
		if columns := node.Attrs["columns"]; columns != "" {
			value, err := strconv.Atoi(columns)
			if err != nil || value < 1 || value > 4 {
				return nodeError(node, "screen columns must be 1..4")
			}
		}
		validator.elements = map[string]bool{node.Attrs["id"]: true}
		validator.elementCount = 0
		validator.screenOpen = true
		validator.sawEffect = true
		return nil
	case "capability":
		if node.Depth != 0 {
			return nodeError(node, "capability must be a root node")
		}
		commands := capabilityCommands[node.Attrs["type"]]
		if commands == nil || !commands[node.Attrs["command"]] {
			return nodeError(node, "unsupported capability command")
		}
		if err := boundedAttribute(node, "id", 31); err != nil {
			return err
		}
		validator.screenOpen = false
		validator.sawEffect = true
		return nil
	case "patch", "remove":
		if node.Depth != 0 {
			return nodeError(node, node.Kind+" must be a root node")
		}
		target := node.Attrs["target"]
		if target == "" || !validator.elements[target] {
			return nodeError(node, node.Kind+" target does not exist")
		}
		if err := boundedAttribute(node, "target", 31); err != nil {
			return err
		}
		if node.Kind == "remove" {
			delete(validator.elements, target)
		}
		return nil
	case "done":
		if node.Depth != 0 {
			return nodeError(node, "done must be a root node")
		}
		validator.screenOpen = false
		return nil
	case "error":
		if node.Depth != 0 || node.Attrs["message"] == "" {
			return nodeError(node, "error must be a root node with a message")
		}
		validator.screenOpen = false
		validator.sawEffect = true
		return nil
	}

	if !elements[node.Kind] {
		return nodeError(node, "unsupported node kind "+node.Kind)
	}
	if !validator.screenOpen || node.Depth < 1 {
		return nodeError(node, node.Kind+" must be nested under a screen")
	}
	if node.Kind == "bind" && !inputs[node.Attrs["input"]] {
		return nodeError(node, "unsupported bind input "+node.Attrs["input"])
	}
	if err := boundedAttribute(node, "id", 31); err != nil {
		return err
	}
	if err := boundedAttribute(node, "action", 47); err != nil {
		return err
	}
	if node.Kind == "field" && (node.Attrs["type"] == "slider" || node.Attrs["type"] == "dial") {
		values := make(map[string]int)
		for _, key := range []string{"min", "max", "step", "value"} {
			v, err := strconv.Atoi(node.Attrs[key])
			if err != nil {
				return nodeError(node, "control requires integer "+key)
			}
			values[key] = v
		}
		if values["min"] < 0 || values["max"] > 604800 || values["min"] >= values["max"] || values["step"] < 1 || values["step"] > values["max"]-values["min"] || values["value"] < values["min"] || values["value"] > values["max"] {
			return nodeError(node, "invalid control range")
		}
	}
	if node.Attrs["action"] == "local.run" {
		kind := node.Attrs["capability"]
		if (kind != "timer" && kind != "reminder" && kind != "alarm") || node.Attrs["task"] == "" {
			return nodeError(node, "invalid local capability")
		}
		if err := boundedAttribute(node, "task", 71); err != nil {
			return err
		}
		if node.Attrs["seconds"] != "$value" || node.Kind != "field" {
			seconds, err := strconv.Atoi(node.Attrs["seconds"])
			if err != nil || seconds < 1 || seconds > 604800 {
				return nodeError(node, "local seconds must be 1..604800 or field $value")
			}
		}
	}
	validator.elementCount++
	if validator.elementCount > MaxElements {
		return nodeError(node, fmt.Sprintf("screen exceeds %d elements", MaxElements))
	}
	if id := node.Attrs["id"]; id != "" {
		if validator.elements[id] {
			return nodeError(node, "duplicate element id "+id)
		}
		validator.elements[id] = true
	}
	return nil
}

func ErrorDocument(message string) string {
	return "pam version=1\nerror message=" + Quote(shortMessage(message)) + "\n"
}

func ErrorLine(message string) string {
	return "error message=" + Quote(shortMessage(message)) + "\n"
}

func Quote(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	value = strings.ReplaceAll(value, "\n", "\\n")
	value = strings.ReplaceAll(value, "\r", "\\r")
	value = strings.ReplaceAll(value, "\t", "\\t")
	return "\"" + value + "\""
}

func shortMessage(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "Agent failed"
	}
	message = strings.ToValidUTF8(message, "�")
	const limit = 240
	if len(message) > limit {
		end := limit
		for end > 0 && !utf8.RuneStart(message[end]) {
			end--
		}
		message = message[:end]
	}
	return message
}

func set(values ...string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func nodeError(node *Node, message string) error {
	return fmt.Errorf("PAM line %d: %s", node.Line, message)
}

func boundedAttribute(node *Node, name string, limit int) error {
	if len(node.Attrs[name]) > limit {
		return nodeError(node, fmt.Sprintf("%s exceeds %d bytes", name, limit))
	}
	return nil
}
