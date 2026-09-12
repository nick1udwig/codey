#include "ripple.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
  assert(ripple_reflect(-8, 200) == 8);
  assert(ripple_reflect(205, 200) == 193);
  assert(ripple_reflect(-408, 200) == 10);
  assert(ripple_reflect(10, 1) == 0);
  assert(ripple_radius(200, 0) == 0);
  assert(ripple_radius(200, RIPPLE_FRAMES) == 100);
  for (int frame = 0; frame <= RIPPLE_FRAMES; frame++)
    for (int origin = 0; origin < 200; origin++) {
      int radius = ripple_radius(200, frame);
      int x = ripple_reflect(origin - radius, 200),
          y = ripple_reflect(origin + radius, 200);
      assert(x >= 0 && x < 200 && y >= 0 && y < 200);
    }
  RipplePoint p = ripple_round(245, 130, 100, 0, 260);
  assert(p.x >= 170 && p.x <= 174 && p.y == 130);
  for (int x = 2; x < 258; x += 7)
    for (int y = 2; y < 258; y += 7) {
      if ((x - 130) * (x - 130) + (y - 130) * (y - 130) > 128 * 128)
        continue;
      for (int dx = -130; dx <= 130; dx += 13)
        for (int dy = -130; dy <= 130; dy += 13) {
          if (dx * dx + dy * dy > 130 * 130)
            continue;
          p = ripple_round(x, y, dx, dy, 260);
          assert((p.x - 130) * (p.x - 130) + (p.y - 130) * (p.y - 130) <=
                 128 * 128);
        }
    }
  puts("✓ ripple radius, half-width travel, edge and corner reflection bounds");
}
