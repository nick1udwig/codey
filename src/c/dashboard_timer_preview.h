#pragma once
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Native schedule subtitles contain MM:SS or H:MM:SS followed by status text.
// Compact minutes round up; multi-hour labels retain their whole hours.
static inline void dashboard_timer_preview(char *out, size_t size,
                                           const char *duration, bool compact) {
  const char *colon = strchr(duration, ':');
  if (!colon) {
    snprintf(out, size, "%s", !strncmp(duration, "Finished", 8) ? "0s" : "--");
    return;
  }
  unsigned first = (unsigned)atoi(duration), seconds = (unsigned)atoi(colon + 1);
  const char *last = strchr(colon + 1, ':');
  char unit;
  if (last) {
    if (!compact) { snprintf(out, size, "%uh%um", first, seconds); return; }
    unit = 'h';
  } else if (!first) { first = seconds; unit = 's'; }
  else if (compact) { first += seconds != 0; unit = 'm'; }
  else { snprintf(out, size, "%u:%02u", first, seconds); return; }
  snprintf(out, size, "%u%c", first, unit);
}
