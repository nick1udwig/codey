/* SPDX-FileCopyrightText: 2024 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 * Adapted from PebbleOS apps/system/timeline/{layer,relbar}.c.
 * Changes: bounded watchapp geometry and explicit event metadata inputs.
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { TimelineRelationNone, TimelineRelationFree,
               TimelineRelationAdjacent, TimelineRelationOverlap } TimelineRelation;

static inline TimelineRelation timeline_relationship(int32_t start, int32_t end,
    int32_t next_start, bool all_day, bool same_day) {
  if (all_day || end <= start || !same_day) return TimelineRelationNone;
  if (next_start > end) return TimelineRelationFree;
  if (next_start == end) return TimelineRelationAdjacent;
  return TimelineRelationOverlap;
}

// PebbleOS uses a 110px expanded pin and a 66px compact pin on a 168px
// rectangular display; its large style uses 131/88. Scale for Emery/Gabbro.
static inline int timeline_expanded_height(int height) { return height >= 200 ? 131 : 110; }
static inline int timeline_compact_height(int height) { return height >= 200 ? 88 : 66; }
static inline int timeline_sidebar_width(int width) {
#if defined(PBL_ROUND)
  return width >= 240 ? 51 : 48;
#else
  return width >= 200 ? 34 : 30;
#endif
}
static inline int timeline_top_inset(void) {
#if defined(PBL_ROUND)
  return 10;
#else
  return 0;
#endif
}
static inline int timeline_left_inset(void) {
#if defined(PBL_ROUND)
  return 26;
#else
  return 4;
#endif
}
