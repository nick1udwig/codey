#pragma once

#include <pebble.h>

typedef struct {
  uint32_t request_id;
  bool pending;
} AnswerNotification;

static inline void answer_notification_complete(AnswerNotification *state,
                                                uint32_t request_id, bool enabled) {
  if (!state->pending || !request_id || request_id != state->request_id) { return; }
  state->pending = false;
  if (enabled && !quiet_time_is_active()) {
    vibes_short_pulse();
  }
}
