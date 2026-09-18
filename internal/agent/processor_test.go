package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/nick1udwig/pebble-agent/internal/appserver"
	"github.com/nick1udwig/pebble-agent/internal/pam"
)

func processorNotification(method, id, phase, text string) appserver.Notification {
	params := map[string]any{"turnId": "turn", "itemId": id, "delta": text,
		"item": map[string]any{"id": id, "type": "agentMessage", "phase": phase, "text": text}}
	raw, _ := json.Marshal(params)
	return appserver.Notification{Method: method, Params: raw}
}

func TestProcessorTextPresence(t *testing.T) {
	const document = "pam version=1\nscreen id=answer layout=card\n  text id=body value=Hello\ndone\n"
	start := processorNotification("item/started", "answer", "final_answer", "")
	delta := processorNotification("item/agentMessage/delta", "answer", "", document)
	completed := processorNotification("item/completed", "answer", "final_answer", document)
	for name, notifications := range map[string][]appserver.Notification{
		"normal":         {start, delta, completed, completed},
		"early delta":    {delta, start, completed},
		"completed only": {completed, completed},
		"empty delta":    {start, processorNotification("item/agentMessage/delta", "answer", "", ""), completed},
		"commentary":     {processorNotification("item/agentMessage/delta", "thinking", "", "Ignore me\n"), processorNotification("item/started", "thinking", "commentary", ""), processorNotification("item/completed", "thinking", "commentary", "Ignore me\n"), completed},
		"multiple items": {processorNotification("item/completed", "header", "final_answer", "pam version=1\n"), processorNotification("item/completed", "body", "final_answer", document[len("pam version=1\n"):])},
	} {
		t.Run(name, func(t *testing.T) {
			var output bytes.Buffer
			stream := pam.NewOutputStream(func(p []byte) error { _, err := output.Write(p); return err })
			processor := newTurnProcessor("turn", stream)
			for _, n := range notifications {
				if _, err := processor.Accept(n); err != nil {
					t.Fatal(err)
				}
			}
			if err := stream.Finish(); err != nil {
				t.Fatal(err)
			}
			want := document
			if output.String() != want {
				t.Fatalf("output %q", output.String())
			}
		})
	}
}

func TestProcessorPropagatesStreamFailure(t *testing.T) {
	want := errors.New("sink failed")
	processor := newTurnProcessor("turn", pam.NewOutputStream(func([]byte) error { return want }))
	_, err := processor.Accept(processorNotification("item/completed", "answer", "final_answer", "pam version=1\n"))
	if !errors.Is(err, want) {
		t.Fatalf("got %v", err)
	}
}

func BenchmarkProcessorDeltas(b *testing.B) {
	for _, count := range []int{256, 1024, 4096} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			delta := processorNotification("item/agentMessage/delta", "answer", "", "# comment text\n")
			start := processorNotification("item/started", "answer", "final_answer", "")
			b.ReportAllocs()
			for n := 0; n < b.N; n++ {
				processor := newTurnProcessor("turn", pam.NewOutputStream(func([]byte) error { return nil }))
				if _, err := processor.Accept(start); err != nil {
					b.Fatal(err)
				}
				for i := 0; i < count; i++ {
					if _, err := processor.Accept(delta); err != nil {
						b.Fatal(err)
					}
				}
			}
		})
	}
}
