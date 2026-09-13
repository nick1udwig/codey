package pam

import (
	"bytes"
	"strings"
	"testing"
)

func TestOutputRepairsTrailingUnquotedDisplayTextAtEverySplit(t *testing.T) {
	source := "pam version=1\nscreen id=answer layout=card title=Bible app version\n  text id=body value=Found the local files\ndone\n"
	for split := 0; split <= len(source); split++ {
		var output bytes.Buffer
		stream := NewOutputStream(func(p []byte) error { _, err := output.Write(p); return err })
		for _, chunk := range []string{source[:split], source[split:]} {
			if err := stream.Push(chunk); err != nil {
				t.Fatalf("split %d: %v", split, err)
			}
		}
		if err := stream.Finish(); err != nil {
			t.Fatal(err)
		}
		nodes, err := Decode(output.Bytes(), MaxOutputBytes)
		if err != nil {
			t.Fatal(err)
		}
		if nodes[1].Attrs["title"] != "Bible app version" || nodes[2].Attrs["value"] != "Found the local files" {
			t.Fatal(output.String())
		}
	}
	// Input and protocol parsing remain strict.
	if _, err := Decode([]byte(source), MaxOutputBytes); err == nil {
		t.Fatal("strict parser accepted malformed attributes")
	}
}

func TestOutputNormalizationDoesNotGuessAmbiguousOrActionAttributes(t *testing.T) {
	for _, source := range []string{
		`capability type=timer command=start title=Pasta timer`,
		`screen id=two words layout=card`,
		`screen id=a layout=card title="Unclosed title`,
		`screen id=a layout=card title=Some words status=true`,
		`screen id=a layout=card title=Answer status=not true`,
		`screen id=a layout=card title="Already quoted"`,
		`screen id=a layout=card title="Multiple words"   `,
		`screen id=a layout=card title=Answer # trailing comment`,
		`screen id=a layout=card title=Answer # message=ignored words`,
		`screen id=a layout=card title="text with = and ' symbols"`,
		"screen id=a layout=card title=Answer\t",
		"   ",
		"",
	} {
		if got := normalizeOutputLine(source); got != source {
			t.Fatalf("changed %q to %q", source, got)
		}
	}
}

func TestOutputNormalizationRepairsTailsAfterQuotedAttributes(t *testing.T) {
	for _, source := range []string{
		`screen id=a layout=card subtitle="Quoted subtitle" title=Two words`,
		"screen id=a layout=card title=Two words \t",
		"screen id=a layout=card title=Two\twords",
		"screen id=a layout=card title=é漢 🙂",
	} {
		got := normalizeOutputLine(source)
		if got == source {
			t.Fatalf("did not repair %q", source)
		}
		node, err := parseLine(got, 1, DefaultMaxLineBytes, DefaultMaxDepth)
		if err != nil {
			t.Fatalf("invalid repair %q: %v", got, err)
		}
		start := strings.LastIndex(source, "title=") + len("title=")
		if node.Attrs["title"] != strings.TrimRight(source[start:], " \t") {
			t.Fatalf("repair changed title contents: %q", got)
		}
	}
}

func TestUnrecoverableOutputStillDeliversErrorAfterHeaderOrScreen(t *testing.T) {
	for _, prefix := range []string{"pam version=1\n", "pam version=1\nscreen id=a layout=card\n"} {
		var output bytes.Buffer
		stream := NewOutputStream(func(p []byte) error { _, err := output.Write(p); return err })
		err := stream.Push(prefix + "screen id=a layout=card title=\"Unclosed\n")
		if err == nil {
			t.Fatal("expected failure")
		}
		if err := stream.EmitError(err); err != nil {
			t.Fatal(err)
		}
		nodes, err := Decode(output.Bytes(), MaxOutputBytes)
		if err != nil {
			t.Fatal(err)
		}
		if nodes[len(nodes)-1].Kind != "error" || strings.Contains(output.String(), "Unclosed") {
			t.Fatal(output.String())
		}
	}
}
