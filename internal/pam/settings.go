package pam

import "regexp"

var settingValues = map[string]map[string]bool{
	"double_tap":     set("true", "false"),
	"tap_animation":  set("true", "false"),
	"answer_vibrate": set("true", "false"),
	"fast_mode":      set("true", "false"),
	"units":          set("auto", "metric", "imperial"),
	"effort":         set("default", "low", "medium", "high", "xhigh", "max", "ultra"),
	"web_search":     set("disabled", "cached", "live"),
}

var settingModel = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$`)

func validSetting(key, value string) bool {
	if key == "model" {
		return settingModel.MatchString(value)
	}
	return settingValues[key][value]
}

func validateSettingsCapability(node *Node) error {
	for key := range node.Attrs {
		switch key {
		case "type", "command", "key", "value", "id":
		default:
			return nodeError(node, "unsupported settings attribute "+key)
		}
	}
	if !validSetting(node.Attrs["key"], node.Attrs["value"]) {
		return nodeError(node, "unsupported setting or invalid value")
	}
	return nil
}
