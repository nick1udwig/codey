#include <pebble.h>
#define GRect(x,y,w,h) ((GRect){{(x),(y)},{(w),(h)}})
#define GRectZero GRect(0,0,0,0)
#include "dashboard_layout.h"
#include <assert.h>
#include <stdio.h>

static bool overlaps(GRect a, GRect b) {
  return a.origin.x < b.origin.x + b.size.w && b.origin.x < a.origin.x + a.size.w &&
      a.origin.y < b.origin.y + b.size.h && b.origin.y < a.origin.y + a.size.h;
}
static void check(int width, int height, bool round) {
  const char *ids[] = {"calendar", "weather", "collection-preview", "dashboard-summary", "dictate", "todos"};
  GRect board = dashboard_bounds(width, height, round), frames[6];
  for (int i = 0; i < 6; ++i) {
    GRect f = frames[i] = dashboard_layout_frame(board, ids[i]);
    assert(f.size.w >= 40 && f.size.h >= 40);
    assert(f.origin.x >= board.origin.x && f.origin.y >= board.origin.y);
    assert(f.origin.x + f.size.w <= board.origin.x + board.size.w);
    assert(f.origin.y + f.size.h <= board.origin.y + board.size.h);
    if (round) {
      for (int corner = 0; corner < 4; ++corner) {
        int dx = f.origin.x + (corner & 1 ? f.size.w : 0) - width / 2;
        int dy = f.origin.y + (corner & 2 ? f.size.h : 0) - height / 2;
        assert(dx * dx + dy * dy <= width * width / 4);
      }
    }
    for (int j = 0; j < i; ++j) assert(!overlaps(f, frames[j]));
  }
  // Key caps progress from UP to SELECT to DOWN along the right edge.
  assert(frames[3].origin.y < frames[4].origin.y && frames[4].origin.y < frames[5].origin.y);
  assert(frames[3].origin.x == frames[4].origin.x && frames[4].origin.x == frames[5].origin.x);
  assert(frames[2].origin.x < frames[5].origin.x);
  assert(!dashboard_layout_frame(board, "schedule-0").size.h);
}
int main(void) {
  check(200, 228, false);
  check(260, 260, true);
  puts("dashboard: usable nonoverlapping touch targets and round-safe key caps");
}
