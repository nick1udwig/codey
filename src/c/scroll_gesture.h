#pragma once
#include <stdbool.h>
#include <stdlib.h>
#include "touch_guard.h"

// A reading drag can scroll without granting permission to activate controls.
typedef struct {
  bool eligible, dragging;
  int x, y, last_y;
} ScrollGesture;
static inline void scroll_gesture_down(ScrollGesture *g, bool eligible, int x, int y) {
  *g = (ScrollGesture){.eligible=eligible, .x=x, .y=y, .last_y=y};
}
static inline bool scroll_gesture_move(ScrollGesture *g, int x, int y, int *delta) {
  *delta = 0;
  if (!g->eligible) return false;
  if (!g->dragging && abs(y-g->y) > TOUCH_GUARD_SLOP && abs(y-g->y) > abs(x-g->x))
    g->dragging = true;
  if (!g->dragging) return false;
  *delta = y-g->last_y;
  g->last_y = y;
  return true;
}
static inline bool scroll_gesture_up(ScrollGesture *g) {
  bool consumed = g->dragging;
  *g = (ScrollGesture){0};
  return consumed;
}
