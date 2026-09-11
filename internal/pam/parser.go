package pam

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	DefaultMaxLineBytes = 2048
	DefaultMaxDepth     = 8
)

type Node struct {
	Kind       string
	Attrs      map[string]string
	Depth      int
	Line       int
	ParentKind string
}

type Decoder struct {
	MaxLineBytes int
	MaxDepth     int

	headerSeen bool
	line       int
	stack      []Node
}

func NewDecoder() *Decoder {
	return &Decoder{MaxLineBytes: DefaultMaxLineBytes, MaxDepth: DefaultMaxDepth}
}

func (decoder *Decoder) Accept(source string) (*Node, error) {
	decoder.line++
	if strings.HasSuffix(source, "\r") {
		source = strings.TrimSuffix(source, "\r")
	}
	node, err := parseLine(source, decoder.line, decoder.MaxLineBytes, decoder.MaxDepth)
	if err != nil {
		return nil, err
	}
	if node == nil {
		return nil, nil
	}
	if node.Depth > len(decoder.stack) {
		return nil, lineError(node.Line, "node skips a parent indentation level")
	}
	if node.Kind == "pam" {
		if node.Depth != 0 || decoder.headerSeen {
			return nil, lineError(node.Line, "pam header must be the first root node")
		}
		if node.Attrs["version"] != "1" {
			return nil, lineError(node.Line, "unsupported PAM version")
		}
		decoder.headerSeen = true
		decoder.stack = decoder.stack[:0]
		return node, nil
	}
	if !decoder.headerSeen {
		return nil, lineError(node.Line, "document must start with pam version=1")
	}

	decoder.stack = decoder.stack[:node.Depth]
	if node.Depth > 0 {
		node.ParentKind = decoder.stack[node.Depth-1].Kind
	}
	decoder.stack = append(decoder.stack, *node)
	return node, nil
}

func (decoder *Decoder) Finish() error {
	if !decoder.headerSeen {
		return errors.New("document must contain pam version=1")
	}
	return nil
}

func Decode(source []byte, maxDocumentBytes int) ([]Node, error) {
	if maxDocumentBytes > 0 && len(source) > maxDocumentBytes {
		return nil, fmt.Errorf("PAM document exceeds %d bytes", maxDocumentBytes)
	}
	if !utf8.Valid(source) {
		return nil, errors.New("PAM document is not valid UTF-8")
	}
	decoder := NewDecoder()
	lines := strings.Split(string(source), "\n")
	nodes := make([]Node, 0, len(lines))
	for index, line := range lines {
		if index == len(lines)-1 && line == "" {
			break
		}
		node, err := decoder.Accept(line)
		if err != nil {
			return nil, err
		}
		if node != nil {
			nodes = append(nodes, *node)
		}
	}
	if err := decoder.Finish(); err != nil {
		return nil, err
	}
	return nodes, nil
}

func parseLine(source string, line, maxLineBytes, maxDepth int) (*Node, error) {
	if maxLineBytes <= 0 {
		maxLineBytes = DefaultMaxLineBytes
	}
	if maxDepth <= 0 {
		maxDepth = DefaultMaxDepth
	}
	if len(source) > maxLineBytes {
		return nil, lineError(line, "line is too long")
	}
	if strings.TrimSpace(source) == "" || strings.HasPrefix(strings.TrimSpace(source), "#") {
		return nil, nil
	}

	spaces := 0
	for spaces < len(source) && source[spaces] == ' ' {
		spaces++
	}
	if spaces < len(source) && source[spaces] == '\t' {
		return nil, lineError(line, "tabs are not valid indentation")
	}
	if spaces%2 != 0 {
		return nil, lineError(line, "indentation must use pairs of spaces")
	}
	depth := spaces / 2
	if depth > maxDepth {
		return nil, lineError(line, "maximum nesting depth exceeded")
	}

	index := spaces
	start := index
	for index < len(source) && !isSpace(source[index]) {
		index++
	}
	kind := source[start:index]
	if !validName(kind) {
		return nil, lineError(line, "invalid node kind")
	}

	attrs := make(map[string]string)
	for index < len(source) {
		for index < len(source) && isSpace(source[index]) {
			index++
		}
		if index >= len(source) || source[index] == '#' {
			break
		}
		start = index
		for index < len(source) && isNameByte(source[index]) {
			index++
		}
		key := source[start:index]
		if !validName(key) || index >= len(source) || source[index] != '=' {
			return nil, lineError(line, "expected name=value attribute")
		}
		if _, exists := attrs[key]; exists {
			return nil, lineError(line, "duplicate attribute "+key)
		}
		index++
		value := ""
		if index < len(source) && (source[index] == '\'' || source[index] == '"') {
			var err error
			value, index, err = readQuoted(source, index)
			if err != nil {
				return nil, lineError(line, err.Error())
			}
			if index < len(source) && !isSpace(source[index]) {
				return nil, lineError(line, "quoted value must end at whitespace")
			}
		} else {
			start = index
			for index < len(source) && !isSpace(source[index]) {
				index++
			}
			value = source[start:index]
		}
		attrs[key] = value
	}

	return &Node{Kind: kind, Attrs: attrs, Depth: depth, Line: line}, nil
}

func readQuoted(source string, index int) (string, int, error) {
	quote := source[index]
	index++
	var output strings.Builder
	for index < len(source) {
		marker := source[index]
		if marker == quote {
			return output.String(), index + 1, nil
		}
		if marker != '\\' {
			output.WriteByte(marker)
			index++
			continue
		}
		index++
		if index >= len(source) {
			return "", 0, errors.New("unfinished escape")
		}
		switch source[index] {
		case 'n':
			output.WriteByte('\n')
		case 'r':
			output.WriteByte('\r')
		case 't':
			output.WriteByte('\t')
		case '\\', '\'', '"':
			output.WriteByte(source[index])
		case 'u':
			if index+4 >= len(source) {
				return "", 0, errors.New("invalid unicode escape")
			}
			value, err := strconv.ParseUint(source[index+1:index+5], 16, 16)
			if err != nil {
				return "", 0, errors.New("invalid unicode escape")
			}
			output.WriteRune(rune(value))
			index += 4
		default:
			return "", 0, fmt.Errorf("unsupported escape \\%c", source[index])
		}
		index++
	}
	return "", 0, errors.New("unterminated quoted value")
}

func validName(value string) bool {
	if value == "" || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for index := 1; index < len(value); index++ {
		if !isNameByte(value[index]) {
			return false
		}
	}
	return true
}

func isNameByte(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= '0' && value <= '9' || value == '_' || value == '-'
}

func isSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n' || value == '\v' || value == '\f'
}

func lineError(line int, message string) error {
	return fmt.Errorf("PAM line %d: %s", line, message)
}
