package pam

import (
	"regexp"
	"strings"
)

// Only repair a trailing display-string attribute in model output. Never relax
// the request parser or reinterpret command arguments, IDs, or malformed quotes.
var bareDisplayTail = regexp.MustCompile(`(?:^|[ \t])(title|subtitle|label|value|message)=([^\s"'][^="'\r\n]*)$`)

func normalizeOutputLine(source string) string {
	// A repairable multiword value ends in a word without = or quotes.
	// Skip the speculative parse for ordinary key=value and quoted tails;
	// OutputValidator still parses and validates every line afterward.
	tail := strings.TrimRight(source, " \t")
	tail = tail[strings.LastIndexAny(tail, " \t")+1:]
	if strings.ContainsAny(tail, "=\"'") {
		return source
	}
	if _, err := parseLine(source, 1, DefaultMaxLineBytes, DefaultMaxDepth); err == nil {
		return source
	}
	fields := strings.Fields(source)
	if len(fields) == 0 || !set("screen", "text", "item", "section", "metric", "error")[fields[0]] {
		return source
	}
	match := bareDisplayTail.FindStringSubmatchIndex(source)
	if match == nil {
		return source
	}
	start, end := match[4], match[5]
	value := strings.TrimRight(source[start:end], " \t")
	if !strings.ContainsAny(value, " \t") {
		return source
	}
	candidate := source[:start] + Quote(value)
	if _, err := parseLine(candidate, 1, DefaultMaxLineBytes, DefaultMaxDepth); err != nil {
		return source
	}
	return candidate
}
