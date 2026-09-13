package pam

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func BenchmarkOutputStream(b *testing.B) {
	source := "pam version=1\nscreen id=answer layout=list title=Answer\n"
	for i := 0; i < MaxElements; i++ {
		source += fmt.Sprintf("  text id=t%d value=%s\n", i, strings.Repeat("x", 120))
	}
	source += "done\n"
	for _, size := range []int{1, 32, len(source)} {
		b.Run(fmt.Sprintf("chunk-%d", size), func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(source)))
			for i := 0; i < b.N; i++ {
				stream := NewOutputStream(func([]byte) error { return nil })
				for start := 0; start < len(source); start += size {
					if err := stream.Push(source[start:min(start+size, len(source))]); err != nil {
						b.Fatal(err)
					}
				}
				if err := stream.Finish(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestOutputStreamRetainsEmittedLinesAcrossBufferReuse(t *testing.T) {
	source := "pam version=1\r\nscreen id=a layout=card title=\"é漢🙂\"\r\n  text id=b value=hello\r\ndone"
	want := strings.ReplaceAll(source, "\r\n", "\n") + "\n"
	for size := 1; size <= len(source); size++ {
		var lines [][]byte
		stream := NewOutputStream(func(p []byte) error { lines = append(lines, p); return nil })
		for start := 0; start < len(source); start += size {
			if err := stream.Push(source[start:min(start+size, len(source))]); err != nil {
				t.Fatalf("chunk size %d: %v", size, err)
			}
		}
		if err := stream.Finish(); err != nil {
			t.Fatal(err)
		}
		if got := string(bytes.Join(lines, nil)); got != want {
			t.Fatalf("chunk size %d: got %q", size, got)
		}
	}
}

func TestOutputStreamBoundsPartialLineStorage(t *testing.T) {
	for _, prefix := range []string{"", "pam version=1\n", "pam ver"} {
		for _, suffix := range []string{"", "\n"} {
			stream := NewOutputStream(func([]byte) error { return nil })
			if err := stream.Push(prefix); err != nil {
				t.Fatal(err)
			}
			if err := stream.Push(strings.Repeat("x", 1<<20) + suffix); err == nil {
				t.Fatal("accepted oversized line")
			}
			if cap(stream.buffer) > 2*(DefaultMaxLineBytes+1) {
				t.Fatalf("retained oversized buffer: %d", cap(stream.buffer))
			}
		}
	}
}

func TestOutputStreamAllowsMaxLengthCRLFAtEverySplit(t *testing.T) {
	line := "#" + strings.Repeat("x", DefaultMaxLineBytes-1) + "\r\n"
	for split := 0; split <= len(line); split++ {
		stream := NewOutputStream(func([]byte) error { return nil })
		for _, chunk := range []string{line[:split], line[split:]} {
			if err := stream.Push(chunk); err != nil {
				t.Fatalf("split %d: %v", split, err)
			}
		}
	}
}

func TestOutputStreamStopsOnEmitError(t *testing.T) {
	want := errors.New("disconnected")
	calls := 0
	stream := NewOutputStream(func([]byte) error { calls++; return want })
	if err := stream.Push("pam version=1\nscreen id=a layout=card\n"); !errors.Is(err, want) {
		t.Fatalf("got %v", err)
	}
	if calls != 1 {
		t.Fatalf("emitted %d lines after failure", calls)
	}
}
