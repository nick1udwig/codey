package agent

import (
	"context"
	"fmt"
)

// DashboardStatus deliberately uses the current multi-bucket quota API.
// A missing percentage/count means unknown, never zero or a guessed value.
type DashboardStatus struct {
	RemainingPercent *int   `json:"remainingPercent"`
	ActiveThreads    *int   `json:"activeThreads"`
	State            string `json:"state"`
}
type rateWindow struct {
	UsedPercent int `json:"usedPercent"`
}
type rateSnapshot struct {
	Primary   *rateWindow `json:"primary"`
	Secondary *rateWindow `json:"secondary"`
}

func remainingQuota(bucket rateSnapshot) *int {
	var remaining *int
	for _, window := range []*rateWindow{bucket.Primary, bucket.Secondary} {
		if window == nil {
			continue
		}
		value := 100 - window.UsedPercent
		if value < 0 {
			value = 0
		}
		if value > 100 {
			value = 100
		}
		if remaining == nil || value < *remaining {
			v := value
			remaining = &v
		}
	}
	return remaining
}
func (agent *Agent) DashboardStatus(ctx context.Context) (DashboardStatus, error) {
	result := DashboardStatus{State: "unknown"}
	connection, _, _, err := agent.client.Connection(ctx)
	if err != nil {
		return result, err
	}
	var limits struct {
		Buckets map[string]rateSnapshot `json:"rateLimitsByLimitId"`
	}
	if connection.Request(ctx, "account/rateLimits/read", nil, &limits) == nil {
		result.RemainingPercent = remainingQuota(limits.Buckets["codex"])
	}
	count := 0
	cursor := ""
	seen := map[string]bool{}
	cursors := map[string]bool{}
	for {
		var page struct {
			Data       []string `json:"data"`
			NextCursor *string  `json:"nextCursor"`
		}
		params := map[string]any{"limit": 100}
		if cursor != "" {
			params["cursor"] = cursor
		}
		if err = connection.Request(ctx, "thread/loaded/list", params, &page); err != nil {
			return result, nil
		}
		for _, id := range page.Data {
			if seen[id] {
				continue
			}
			seen[id] = true
			var read struct {
				Thread struct {
					Status struct {
						Type string `json:"type"`
					} `json:"status"`
				} `json:"thread"`
			}
			if err = connection.Request(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false}, &read); err != nil {
				return result, nil
			}
			switch read.Thread.Status.Type {
			case "active":
				count++
			case "idle", "notLoaded":
			case "systemError":
				result.State = "error"
			default:
				return result, nil
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		cursor = *page.NextCursor
		if cursors[cursor] {
			return result, fmt.Errorf("repeated loaded-thread cursor")
		}
		cursors[cursor] = true
	}
	result.ActiveThreads = &count
	if result.State != "error" {
		if count > 0 {
			result.State = "working"
		} else {
			result.State = "idle"
		}
	}
	return result, nil
}
