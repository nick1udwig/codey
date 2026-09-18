#pragma once
#include <stdbool.h>
#include <stdint.h>

enum {
  UiDirtyGeometry = 1,
  UiDirtyContent = 2,
  UiDirtyActions = 4,
  UiDirtyClock = 8,
  UiDirtyAll = 15
};
static inline uint8_t ui_invalidation_expand(uint8_t flags) {
  return flags & UiDirtyGeometry ? flags | UiDirtyContent | UiDirtyActions : flags;
}
static inline uint8_t ui_invalidation_clock(bool clock_in_content) {
  return UiDirtyClock | (clock_in_content ? UiDirtyContent : 0);
}
static inline bool ui_invalidation_visible(bool visible, bool structural) {
  // Structural navigation may need to close an old NumberWindow.
  return visible || structural;
}
