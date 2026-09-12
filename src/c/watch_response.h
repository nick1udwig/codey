#pragma once
#include <stdbool.h>
#include <stdint.h>

// The phone assigns its own response IDs. Bind that ID before any screen or
// status arrives, and reject stale traffic once a request has failed.
typedef struct {
  uint32_t request_id;
  bool awaiting_begin;
  bool active;
} WatchResponse;

static inline void watch_response_wait(WatchResponse *state) {
  *state = (WatchResponse) { .awaiting_begin = true };
}
static inline bool watch_response_begin(WatchResponse *state, uint32_t id) {
  if (!state->awaiting_begin || !id) { return false; }
  *state = (WatchResponse) { .request_id = id, .active = true };
  return true;
}
static inline bool watch_response_accepts(const WatchResponse *state, uint32_t id) {
  return state->active && id && state->request_id == id;
}
static inline void watch_response_fail(WatchResponse *state) {
  state->active = false;
  state->awaiting_begin = false;
}
