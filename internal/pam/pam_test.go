package pam

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseRequest(t *testing.T) {
	source := "pam version=1\n" +
		"request id=42 protocol=pam/1 session=watch-1\n" +
		"  input kind=dictation text=\"Set a five minute timer\" action= element= value=\n" +
		"  context screen=home layout=card selected=\n" +
		"  device platform=emery model=pebble_time_2 shape=rect touch=true\n" +
		"done\n"
	request, err := ParseRequest([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	if request.ID != 42 || request.Session != "watch-1" || request.Input["kind"] != "dictation" {
		t.Fatalf("unexpected request: %#v", request)
	}
	if request.Input["text"] != "Set a five minute timer" || request.Device["touch"] != "true" {
		t.Fatalf("request attributes were not decoded: %#v", request)
	}
}

func TestParseRequestKeepsWebSocketBearerOutOfAgentDocument(t *testing.T) {
	source := "pam version=1\n" +
		"request id=7 protocol=pam/1 session=watch-1\n" +
		"  input kind=dictation text=hello\n" +
		"  auth bearer=highly-secret\n" +
		"done\n"
	request, err := ParseRequest([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	if request.Bearer != "highly-secret" {
		t.Fatalf("bearer was not parsed: %q", request.Bearer)
	}
	if strings.Contains(request.Raw, "highly-secret") || strings.Contains(request.Raw, "auth") {
		t.Fatalf("model-facing request leaked authentication: %q", request.Raw)
	}
	if _, err := ParseRequest([]byte(request.Raw)); err != nil {
		t.Fatalf("canonical request is invalid PAM: %v", err)
	}
}

func TestParseRequestRejectsMalformedStructure(t *testing.T) {
	cases := []string{
		"request id=1 protocol=pam/1 session=x\n  input kind=dictation\ndone\n",
		"pam version=1\nrequest id=0 protocol=pam/1 session=x\n  input kind=dictation\ndone\n",
		"pam version=1\nrequest id=1 protocol=json session=x\n  input kind=dictation\ndone\n",
		"pam version=1\nrequest id=1 protocol=pam/1 session=x\n    input kind=dictation\ndone\n",
		"pam version=1\nrequest id=1 protocol=pam/1 session=x\n  input kind=dictation\n  input kind=select\ndone\n",
	}
	for _, source := range cases {
		if _, err := ParseRequest([]byte(source)); err == nil {
			t.Fatalf("expected rejection for %q", source)
		}
	}
}

func TestOutputStreamValidatesArbitraryChunksAndAddsDone(t *testing.T) {
	var output bytes.Buffer
	stream := NewOutputStream(func(payload []byte) error {
		_, err := output.Write(payload)
		return err
	})
	chunks := []string{"pam ver", "sion=1\nscreen id=answer lay", "out=card title=Answer\n  text id=body value=\"Hel", "lo watch\"\n"}
	for _, chunk := range chunks {
		if err := stream.Push(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err := stream.Finish(); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(output.String(), "done\n") {
		t.Fatalf("missing automatic done: %q", output.String())
	}
	if _, err := Decode(output.Bytes(), MaxOutputBytes); err != nil {
		t.Fatalf("stream produced invalid PAM: %v", err)
	}
}

func TestOutputStreamForwardsTimerCapabilityUnchanged(t *testing.T) {
	const source = "pam version=1\n" +
		"capability type=timer command=start id=timer-5s title=\"5-second timer\" duration=5s\n" +
		"done\n"
	var output bytes.Buffer
	stream := NewOutputStream(func(payload []byte) error {
		_, err := output.Write(payload)
		return err
	})
	for _, chunk := range []string{source[:17], source[17:64], source[64:]} {
		if err := stream.Push(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err := stream.Finish(); err != nil {
		t.Fatal(err)
	}
	if got := output.String(); got != source {
		t.Fatalf("timer response = %q, want %q", got, source)
	}
}

func TestOutputValidatorRejectsUnsafeOrUnrenderableOutput(t *testing.T) {
	cases := []string{
		"```pam",
		"pam version=1\ncapability type=shell command=run",
		"pam version=1\nscreen id=x layout=unknown",
		"pam version=1\nscreen id=x layout=list\n  bind id=b input=long-select action=nope",
		"pam version=1\nscreen id=x layout=list\n  item id=a title=A\n  item id=a title=B",
		"pam version=1\nscreen id=abcdefghijklmnopqrstuvwxyz123456 layout=card",
		"pam version=1\nscreen id=x layout=grid columns=5",
	}
	for _, source := range cases {
		validator := NewOutputValidator()
		var found bool
		for _, line := range strings.Split(source, "\n") {
			if _, err := validator.Accept(line); err != nil {
				found = true
				break
			}
		}
		if !found {
			if _, err := validator.Finish(); err != nil {
				found = true
			}
		}
		if !found {
			t.Fatalf("expected output rejection for %q", source)
		}
	}
}

func TestErrorDocumentQuotesProtocolCharacters(t *testing.T) {
	source := ErrorDocument("bad \"value\"\nnext")
	nodes, err := Decode([]byte(source), MaxOutputBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 || nodes[1].Attrs["message"] != "bad \"value\"\nnext" {
		t.Fatalf("unexpected error document: %#v", nodes)
	}
}

func TestAlarmAndDashboardCommands(t *testing.T) {
	for _, line := range []string{
		"capability type=alarm command=schedule id=wake at=1789145375",
		"capability type=alarm command=ack id=wake",
		"capability type=reminder command=show id=medicine",
		"capability type=timer command=list",
		"capability type=timer command=cancel_all",
	} {
		stream := NewOutputStream(func([]byte) error { return nil })
		if err := stream.Push("pam version=1\n" + line + "\n"); err != nil {
			t.Fatal(err)
		}
		if err := stream.Finish(); err != nil {
			t.Fatal(err)
		}
	}
}
