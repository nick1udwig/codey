#pragma once
#include "touch_guard.h"
#include "scroll_gesture.h"

typedef enum { GestureDown, GestureMove, GestureUp } GestureContact;
typedef struct { TouchGuard guard; ScrollGesture scroll; } GestureController;

// Gesture recognition owns no UI widgets. The UI supplies semantic targets,
// coordinates and time, then performs navigation/animation only when accepted.
static inline void gesture_controller_reset(GestureController *controller) {
  touch_guard_reset(&controller->guard);
  controller->scroll = (ScrollGesture){0};
}
static inline bool gesture_controller_contact(GestureController *controller,
    GestureContact phase, int32_t target, int x, int y, uint32_t now, bool double_tap) {
  switch (phase) {
    case GestureDown: return touch_guard_down_mode(&controller->guard,target,x,y,now,double_tap);
    case GestureMove: return touch_guard_move(&controller->guard,x,y);
    case GestureUp: return touch_guard_up(&controller->guard,target,x,y,now);
  }
  return false;
}
