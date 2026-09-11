package pam

import (
	"strings"
	"testing"
)

func TestBackendOptionsAreValidatedAndExcludedFromModelInput(t *testing.T) {
	source := "pam version=1\nrequest id=1 session=test protocol=pam/1\n  input kind=dictation text=hello\n  backend model=test-model effort=high web_search=live file_access=workspace-write network_access=true shell_access=true auto_review=true\ndone\n"
	request, err := ParseRequest([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	if request.Backend.Model != "test-model" || request.Backend.Effort != "high" || !request.Backend.AutoReview || !request.Backend.NetworkAccess || !request.Backend.ShellAccess {
		t.Fatalf("options lost: %#v", request.Backend)
	}
	if strings.Contains(request.Raw, "backend") || strings.Contains(request.Raw, "auto_review") {
		t.Fatalf("backend config entered model input: %s", request.Raw)
	}
	for _, attrs := range []map[string]string{
		{"file_access": "danger-full-access"}, {"web_search": "anything"}, {"auto_review": "yes"}, {"network_access": "1"},
		{"shell_access": "True"}, {"cwd": "/"}, {"approvalPolicy": "never"}, {"model": "bad model"}, {"effort": "bad effort"},
	} {
		if _, err := ParseBackendOptions(attrs); err == nil {
			t.Fatalf("accepted %#v", attrs)
		}
	}
	defaults, _ := ParseBackendOptions(nil)
	if defaults.FileAccess != "none" || defaults.WebSearch != "disabled" || defaults.AutoReview || defaults.NetworkAccess || defaults.ShellAccess {
		t.Fatalf("unsafe defaults %#v", defaults)
	}
}
