package agent

import (
	"github.com/nick1udwig/pebble-agent/internal/pam"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestInstalledSkillAndExamples(t *testing.T) {
	path, err := InstallSkill(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(body), "references/controls.md") {
		t.Fatal("missing skill references", err)
	}
	controls, err := os.ReadFile(filepath.Join(filepath.Dir(path), "references", "controls.md"))
	if err != nil {
		t.Fatal(err)
	}
	examples := regexp.MustCompile("(?s)```pam\\n(.*?)```").FindAllStringSubmatch(string(controls), -1)
	if len(examples) < 2 {
		t.Fatal("missing interactive examples")
	}
	for _, example := range examples {
		validator := pam.NewOutputValidator()
		for _, line := range strings.Split(strings.TrimSpace(example[1]), "\n") {
			if _, err := validator.Accept(line); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := validator.Finish(); err != nil {
			t.Fatal(err)
		}
	}
	a := &Agent{config: Config{SkillPath: path}}
	if !strings.Contains(a.instructions(true), path) {
		t.Fatal("skill not discoverable")
	}
	if !strings.Contains(a.instructions(false), "## Explaining Pebble Agent") || !strings.Contains(a.instructions(false), "# Pebble Agent feature guide") {
		t.Fatal("tool-disabled fallback missing app help")
	}
	if !strings.Contains(a.instructions(false), "type=slider") {
		t.Fatal("tool-disabled fallback missing")
	}
}
