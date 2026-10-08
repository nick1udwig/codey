#pragma once
#include <stdbool.h>
#include <stdint.h>
#define UI_BACKGROUND_DEFAULT_INTERVAL_MS 60000u
static inline uint32_t refresh_policy_interval_ms(int32_t seconds) {
  return seconds == 1 ? 1000u : UI_BACKGROUND_DEFAULT_INTERVAL_MS;
}
typedef struct {
  uint32_t painted_at;
  uint32_t interval_ms;
  bool painted;
} RefreshPolicy;
static inline uint32_t refresh_policy_delay(const RefreshPolicy *p,
                                            uint32_t now, bool user_input) {
  if (user_input || !p->painted)
    return 0;
  uint32_t elapsed = now - p->painted_at;
  uint32_t interval = p->interval_ms ? p->interval_ms : UI_BACKGROUND_DEFAULT_INTERVAL_MS;
  return elapsed >= interval ? 0 : interval - elapsed;
}
static inline void refresh_policy_painted(RefreshPolicy *p, uint32_t now) {
  p->painted = true;
  p->painted_at = now;
}

// Replacing a screen invalidates all element frames; waiting here could leave
// a blank page after an OS notification covers and restores the app.
static inline uint32_t refresh_policy_screen_delay(const RefreshPolicy *p,uint32_t now,bool input,bool structural){return refresh_policy_delay(p,now,input||structural);}
