package pam

import (
	"strings"
	"testing"
)

func TestInteractiveControlValidation(t *testing.T) {
	for _, row := range []struct {
		node  string
		valid bool
	}{
		{`choice id=d title="Day" action=local.run capability=reminder seconds=86400 task="Card"`, true},
		{`field id=s title="Delay" type=dial min=60 max=3600 step=60 value=300 action=local.run capability=timer seconds="$value" task="Tea"`, true},
		{`field id=s type=slider min=10 max=5 step=1 value=10`, false},
		{`choice id=d action=local.run capability=shell seconds=1 task="bad"`, false},
		{`choice id=d action=local.run capability=timer seconds=0 task="bad"`, false},
	} {
		v := NewOutputValidator()
		var err error
		for _, line := range strings.Split("pam version=1\nscreen id=q layout=form\n  "+row.node+"\ndone", "\n") {
			if _, err = v.Accept(line); err != nil {
				break
			}
		}
		if (err == nil) != row.valid {
			t.Fatalf("%s: %v", row.node, err)
		}
	}
}
