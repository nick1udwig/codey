package agent

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed skills/pam-ui
var skillFiles embed.FS

// InstallSkill keeps server-owned guidance alongside the session state. The
// app-server must share this filesystem, as it already does for the workspace.
func InstallSkill(root string) (string, error) {
	err := fs.WalkDir(skillFiles, "skills/pam-ui", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(root, path)
		if entry.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		content, err := skillFiles.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, content, 0600)
	})
	if err != nil {
		return "", fmt.Errorf("install PAM skill: %w", err)
	}
	return filepath.Join(root, "skills", "pam-ui", "SKILL.md"), nil
}

func (agent *Agent) instructions(canReadSkill bool) string {
	if agent.config.SkillPath != "" && canReadSkill {
		return developerInstructions + "\nPAM skill: " + agent.config.SkillPath + "\n"
	}
	// Library callers without an installed skill still have complete instructions.
	content, _ := skillFiles.ReadFile("skills/pam-ui/references/protocol.md")
	controls, _ := skillFiles.ReadFile("skills/pam-ui/references/controls.md")
	guide, _ := skillFiles.ReadFile("skills/pam-ui/references/app-guide.md")
	entry, _ := skillFiles.ReadFile("skills/pam-ui/SKILL.md")
	return developerInstructions + "\n" + string(entry) + "\n" + string(content) + "\n" + string(controls) + "\n" + string(guide)
}
