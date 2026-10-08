#include "dashboard_timer_preview.h"
#include <assert.h>

static void check(const char *duration, bool compact, const char *expected) {
  char label[24];
  dashboard_timer_preview(label, sizeof(label), duration, compact);
  assert(!strcmp(label, expected));
}

int main(void) {
  check("00:22 remaining", false, "22s");
  check("00:21 remaining", false, "21s");
  check("00:01 · Paused", false, "1s");
  check("00:59 remaining", false, "59s");
  check("01:00 remaining", false, "1:00");
  check("01:01 remaining", false, "1:01");
  check("20:00 remaining", false, "20:00");
  check("20:00 remaining", true, "20m");
  check("20:01 · Paused", true, "21m");
  check("59:59 remaining", true, "60m");
  check("1:00:00 remaining", false, "1h0m");
  check("1:00:01 remaining", true, "1h");
  check("1:59:59 remaining", false, "1h59m");
  check("1:59:59 remaining", true, "1h");
  check("168:00:00 remaining", false, "168h0m");
  check("168:00:00 remaining", true, "168h");
  check("00:00 remaining", false, "0s");
  check("Finished · Done", false, "0s");
  check("--", false, "--");
  // All sub-minute values retain their exact seconds in either representation.
  for (unsigned seconds = 0; seconds < 60; ++seconds) {
    char subtitle[40], expected[16];
    snprintf(subtitle, sizeof(subtitle), "00:%02u remaining", seconds);
    snprintf(expected, sizeof(expected), "%us", seconds);
    check(subtitle, false, expected);
    check(subtitle, true, expected);
  }
  puts("dashboard timers: exact seconds, bounded units, pause and completion labels");
}
