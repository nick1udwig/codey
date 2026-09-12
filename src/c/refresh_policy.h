#pragma once
#include <stdbool.h>
#include <stdint.h>
#define UI_BACKGROUND_INTERVAL_MS 60000u
typedef struct {
  uint32_t painted_at;
  bool painted;
} RefreshPolicy;
static inline uint32_t refresh_policy_delay(const RefreshPolicy *p,
                                            uint32_t now, bool user_input) {
  if (user_input || !p->painted)
    return 0;
  uint32_t elapsed = now - p->painted_at;
  return elapsed >= UI_BACKGROUND_INTERVAL_MS
             ? 0
             : UI_BACKGROUND_INTERVAL_MS - elapsed;
}
static inline void refresh_policy_painted(RefreshPolicy *p, uint32_t now) {
  p->painted = true;
  p->painted_at = now;
}
