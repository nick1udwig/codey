package pam

import (
	"strings"
	"testing"
)

func TestSettingsCapability(t *testing.T) {
	for _, tc := range []struct {
		attrs string
		valid bool
	}{
		{"key=double_tap value=false", true},
		{"key=tap_animation value=true", true},
		{"key=answer_vibrate value=false", true},
		{"key=fast_mode value=true", true},
		{"key=units value=imperial", true},
		{"key=model value=vendor/Model:1", true},
		{"key=model value=default", true},
		{"key=effort value=default", true},
		{"key=effort value=ultra", true},
		{"key=web_search value=disabled", true},
		{"key=double_tap value=off", false},
		{"key=units value=bananas", false},
		{"key=effort value=extreme", false},
		{"key=web_search value=true", false},
		{`key=model value=""`, false},
		{`key=model value="bad model"`, false},
		{"key=model value=" + strings.Repeat("a", 129), false},
		{"key=token value=secret", false},
		{"key=shell_access value=true", false},
		{"key=auto_review value=true", false},
		{"key=__proto__ value=true", false},
		{"key=double_tap", false},
		{"value=true", false},
		{"key=double_tap value=false shell_access=true", false},
	} {
		t.Run(tc.attrs, func(t *testing.T) {
			v := NewOutputValidator()
			_, _ = v.Accept("pam version=1")
			_, err := v.Accept("capability type=settings command=set " + tc.attrs)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
		})
	}
}

func TestSettingsRequestReachesAgentWithoutAuth(t *testing.T) {
	source := "pam version=1\nrequest id=1 session=test protocol=pam/1\n  input kind=dictation text=Settings\n  settings double_tap=false model=default effort=minimal\n  auth bearer=secret\ndone\n"
	r, err := ParseRequest([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	if r.Settings["double_tap"] != "false" || !strings.Contains(r.Raw, "  settings ") || strings.Contains(r.Raw, "secret") {
		t.Fatalf("unexpected model request: %s", r.Raw)
	}
	// Current preferences may originate in phone settings with a newer vocabulary.
	if !strings.Contains(r.Raw, "effort=minimal") {
		t.Fatal("lost saved preference")
	}
	for _, replacement := range []string{"settings token=secret", "settings double_tap=false\n  settings units=auto"} {
		if _, err := ParseRequest([]byte(strings.Replace(source, "settings double_tap=false model=default effort=minimal", replacement, 1))); err == nil {
			t.Fatal("accepted invalid settings request")
		}
	}
}
