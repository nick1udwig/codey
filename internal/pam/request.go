package pam

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

const MaxRequestBytes = 64 << 10

type Request struct {
	ID       int
	Session  string
	Protocol string
	Input    map[string]string
	Context  map[string]string
	Device   map[string]string
	Settings map[string]string
	Backend  BackendOptions
	Bearer   string
	Raw      string
}

func ParseRequest(source []byte) (Request, error) {
	nodes, err := Decode(source, MaxRequestBytes)
	if err != nil {
		return Request{}, err
	}
	defaults, _ := ParseBackendOptions(nil)
	request := Request{Backend: defaults}
	seen := make(map[string]bool)
	requestSeen := false
	doneSeen := false
	for _, node := range nodes {
		switch node.Kind {
		case "pam":
			continue
		case "request":
			if node.Depth != 0 || requestSeen {
				return Request{}, fmt.Errorf("PAM line %d: expected one root request", node.Line)
			}
			requestSeen = true
			request.Session = node.Attrs["session"]
			request.Protocol = node.Attrs["protocol"]
			request.ID, err = strconv.Atoi(node.Attrs["id"])
			if err != nil || request.ID < 1 || request.ID > 65535 {
				return Request{}, fmt.Errorf("PAM line %d: request id must be 1..65535", node.Line)
			}
		case "input", "context", "device", "auth", "backend", "settings":
			if !requestSeen || doneSeen || node.Depth != 1 || node.ParentKind != "request" {
				return Request{}, fmt.Errorf("PAM line %d: %s must be a request child", node.Line, node.Kind)
			}
			if seen[node.Kind] {
				return Request{}, fmt.Errorf("PAM line %d: duplicate %s node", node.Line, node.Kind)
			}
			seen[node.Kind] = true
			switch node.Kind {
			case "input":
				request.Input = node.Attrs
			case "context":
				request.Context = node.Attrs
			case "device":
				request.Device = node.Attrs
			case "settings":
				for key := range node.Attrs {
					if key != "model" && settingValues[key] == nil {
						return Request{}, nodeError(&node, "unsupported setting")
					}
				}
				request.Settings = node.Attrs
			case "backend":
				request.Backend, err = ParseBackendOptions(node.Attrs)
				if err != nil {
					return Request{}, err
				}
			case "auth":
				request.Bearer = node.Attrs["bearer"]
			}
		case "done":
			if node.Depth != 0 || !requestSeen || doneSeen {
				return Request{}, fmt.Errorf("PAM line %d: invalid done node", node.Line)
			}
			doneSeen = true
		default:
			return Request{}, fmt.Errorf("PAM line %d: unsupported request node %s", node.Line, node.Kind)
		}
	}
	if !requestSeen || !doneSeen {
		return Request{}, errors.New("PAM request requires request and done nodes")
	}
	if request.Protocol != "pam/1" {
		return Request{}, errors.New("request protocol must be pam/1")
	}
	if request.Session == "" || len(request.Session) > 128 {
		return Request{}, errors.New("request session must contain 1..128 bytes")
	}
	if request.Input == nil || request.Input["kind"] == "" {
		return Request{}, errors.New("request requires an input kind")
	}
	if len(request.Input["text"]) > 8192 || len(request.Input["action"]) > 512 || len(request.Input["value"]) > 2048 {
		return Request{}, errors.New("request input exceeds its size limit")
	}
	// Build the model-facing request from parsed fields. In particular, never
	// forward the nested WebSocket bearer credential to Codex app-server.
	request.Raw = request.agentDocument()
	return request, nil
}

func (request Request) agentDocument() string {
	var output strings.Builder
	output.WriteString("pam version=1\nrequest")
	output.WriteString(formatAttributes(map[string]string{
		"id":       strconv.Itoa(request.ID),
		"protocol": request.Protocol,
		"session":  request.Session,
	}))
	output.WriteByte('\n')
	for _, node := range []struct {
		kind  string
		attrs map[string]string
	}{
		{kind: "input", attrs: request.Input},
		{kind: "context", attrs: request.Context},
		{kind: "device", attrs: request.Device},
		{kind: "settings", attrs: request.Settings},
	} {
		if node.attrs == nil {
			continue
		}
		output.WriteString("  ")
		output.WriteString(node.kind)
		output.WriteString(formatAttributes(node.attrs))
		output.WriteByte('\n')
	}
	output.WriteString("done\n")
	return output.String()
}

func formatAttributes(attrs map[string]string) string {
	keys := make([]string, 0, len(attrs))
	for key := range attrs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var output strings.Builder
	for _, key := range keys {
		output.WriteByte(' ')
		output.WriteString(key)
		output.WriteByte('=')
		value := attrs[key]
		if bareValue(value) {
			output.WriteString(value)
		} else {
			output.WriteString(Quote(value))
		}
	}
	return output.String()
}

func bareValue(value string) bool {
	for index := 0; index < len(value); index++ {
		marker := value[index]
		if marker >= 'A' && marker <= 'Z' || marker >= 'a' && marker <= 'z' ||
			marker >= '0' && marker <= '9' || strings.ContainsRune("._:+/-", rune(marker)) {
			continue
		}
		return false
	}
	return true
}
