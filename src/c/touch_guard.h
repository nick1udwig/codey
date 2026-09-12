#pragma once
#include <stdbool.h>
#include <stdint.h>

#define TOUCH_GUARD_ARM_MS 1500
#define TOUCH_GUARD_TAP_MS 500
#define TOUCH_GUARD_SLOP 12

// A qualifying tap arms one target for exactly one subsequent gesture. Keep
// this independent of click handlers: physical controls never pass this gate.
typedef struct {
  bool armed, active, allowed, moved;
  int target, armed_target, x, y;
  uint32_t down_at, armed_at;
} TouchGuard;

static inline void touch_guard_reset(TouchGuard *g) { *g = (TouchGuard){0}; }
static inline bool touch_guard_down(TouchGuard *g, int target, int x, int y, uint32_t now) {
  bool allowed = g->armed && g->armed_target == target &&
                 (uint32_t)(now - g->armed_at) <= TOUCH_GUARD_ARM_MS;
  *g = (TouchGuard){.active=true, .allowed=allowed, .target=target, .x=x, .y=y, .down_at=now};
  return allowed;
}
static inline bool touch_guard_move(TouchGuard *g, int x, int y) {
  int dx = x - g->x, dy = y - g->y;
  if (dx > TOUCH_GUARD_SLOP || dx < -TOUCH_GUARD_SLOP ||
      dy > TOUCH_GUARD_SLOP || dy < -TOUCH_GUARD_SLOP) { g->moved = true; }
  return g->active && g->allowed;
}
static inline bool touch_guard_up(TouchGuard *g, int target, int x, int y, uint32_t now) {
  if (!g->active) { return false; }
  touch_guard_move(g,x,y);
  g->active = false;
  if (g->allowed) { return g->moved || g->target == target; }
  if (!g->moved && g->target == target && (uint32_t)(now - g->down_at) <= TOUCH_GUARD_TAP_MS) {
    g->armed = true; g->armed_target = target; g->armed_at = now;
  }
  return false;
}
