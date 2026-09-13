package pam

import (
	"fmt"
	"strings"
)

type OutputStream struct {
	buffer    []byte
	emit      func([]byte) error
	emitted   bool
	finished  bool
	validator *OutputValidator
}

func NewOutputStream(emit func([]byte) error) *OutputStream {
	return &OutputStream{emit: emit, validator: NewOutputValidator()}
}

func (stream *OutputStream) Push(chunk string) error {
	if stream.finished {
		return fmt.Errorf("cannot write PAM after stream completion")
	}
	for len(chunk) > 0 {
		newline := strings.IndexByte(chunk, '\n')
		end := newline
		if end < 0 {
			end = len(chunk)
		}
		// Allow one extra byte for CRLF, even when split between chunks.
		if len(stream.buffer)+end > DefaultMaxLineBytes+1 {
			return fmt.Errorf("agent output line is too long")
		}
		stream.buffer = append(stream.buffer, chunk[:end]...)
		if len(stream.buffer) > DefaultMaxLineBytes && stream.buffer[len(stream.buffer)-1] != '\r' {
			return fmt.Errorf("agent output line is too long")
		}
		if newline < 0 {
			break
		}
		if err := stream.accept(stream.buffer); err != nil {
			return err
		}
		stream.buffer = stream.buffer[:0]
		chunk = chunk[newline+1:]
	}
	return nil
}

func (stream *OutputStream) Finish() error {
	if stream.finished {
		return nil
	}
	stream.finished = true
	if len(stream.buffer) > 0 {
		if err := stream.accept(stream.buffer); err != nil {
			return err
		}
		stream.buffer = nil
	}
	needsDone, err := stream.validator.Finish()
	if err != nil {
		return err
	}
	if needsDone {
		valid, err := stream.validator.Accept("done")
		if err != nil {
			return err
		}
		if valid {
			if err := stream.emit([]byte("done\n")); err != nil {
				return err
			}
			stream.emitted = true
		}
	}
	return nil
}

func (stream *OutputStream) Emitted() bool { return stream.emitted }

func (stream *OutputStream) EmitError(err error) error {
	payload := ErrorDocument(err.Error())
	if stream.emitted {
		payload = ErrorLine(err.Error())
	}
	return stream.emit([]byte(payload))
}

func (stream *OutputStream) accept(line []byte) error {
	source := normalizeOutputLine(strings.TrimSuffix(string(line), "\r"))
	valid, err := stream.validator.Accept(source)
	if err != nil {
		return err
	}
	if !valid {
		return nil
	}
	payload := []byte(source + "\n")
	if err := stream.emit(payload); err != nil {
		return err
	}
	stream.emitted = true
	return nil
}
