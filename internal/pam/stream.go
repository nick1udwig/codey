package pam

import (
	"bytes"
	"fmt"
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
	stream.buffer = append(stream.buffer, []byte(chunk)...)
	for {
		newline := bytes.IndexByte(stream.buffer, '\n')
		if newline < 0 {
			break
		}
		line := stream.buffer[:newline]
		stream.buffer = stream.buffer[newline+1:]
		if err := stream.accept(line); err != nil {
			return err
		}
	}
	if len(stream.buffer) > DefaultMaxLineBytes {
		return fmt.Errorf("agent output line is too long")
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
	if bytes.HasSuffix(line, []byte{'\r'}) {
		line = bytes.TrimSuffix(line, []byte{'\r'})
	}
	line = []byte(normalizeOutputLine(string(line)))
	valid, err := stream.validator.Accept(string(line))
	if err != nil {
		return err
	}
	if !valid {
		return nil
	}
	payload := append(bytes.Clone(line), '\n')
	if err := stream.emit(payload); err != nil {
		return err
	}
	stream.emitted = true
	return nil
}
