#pragma once
#include <stdint.h>
#define RIPPLE_FRAMES 15
#define RIPPLE_INTERVAL_MS 40
// Mirror a wave point back into the display at an edge. Reflecting points
// (rather than clipping a circle) gives the returning wave at edges/corners.
static inline int ripple_reflect(int position, int extent) {
  if (extent <= 1)
    return 0;
  int period = 2 * (extent - 1);
  position %= period;
  if (position < 0)
    position += period;
  return position < extent ? position : period - position;
}
static inline int ripple_radius(int width, unsigned frame) {
  if (frame > RIPPLE_FRAMES)
    frame = RIPPLE_FRAMES;
  return width * frame / (2 * RIPPLE_FRAMES);
}

static inline uint32_t ripple_sqrt(uint64_t n) {
  uint64_t root = 0, bit = (uint64_t)1 << 62;
  while (bit > n)
    bit >>= 2;
  while (bit) {
    if (n >= root + bit) {
      n -= root + bit;
      root = (root >> 1) + bit;
    } else
      root >>= 1;
    bit >>= 2;
  }
  return (uint32_t)root;
}
typedef struct {
  int x, y;
} RipplePoint;
static inline RipplePoint ripple_round(int x, int y, int dx, int dy,
                                       int width) {
  int center = width / 2, radius = center - 2;
  x -= center;
  y -= center;
  // Reflect the remaining displacement at the circular bezel normal.
  for (int bounce = 0; bounce < 8; ++bounce) {
    int ex = x + dx, ey = y + dy;
    if (ex * ex + ey * ey <= radius * radius)
      return (RipplePoint){ex + center, ey + center};
    int a = dx * dx + dy * dy, b = x * dx + y * dy;
    int c = x * x + y * y - radius * radius;
    if (!a)
      break;
    int64_t discriminant = (int64_t)b * b - (int64_t)a * c;
    if (discriminant < 0)
      break;
    int t = (int)(((int64_t)ripple_sqrt(discriminant) - b) * 65536 / a);
    if (t < 0)
      t = 0;
    if (t > 65536)
      t = 65536;
    x += (int64_t)dx * t / 65536;
    y += (int64_t)dy * t / 65536;
    dx = (int64_t)dx * (65536 - t) / 65536;
    dy = (int64_t)dy * (65536 - t) / 65536;
    int norm = x * x + y * y, dot = dx * x + dy * y;
    if (!norm)
      break;
    dx -= (int64_t)2 * dot * x / norm;
    dy -= (int64_t)2 * dot * y / norm;
  }
  // Pixel rounding at grazing contacts can consume the bounded bounce budget.
  int length = ripple_sqrt((int64_t)x * x + (int64_t)y * y) + 1;
  if (length > radius) {
    x = x * radius / length;
    y = y * radius / length;
  }
  return (RipplePoint){x + center, y + center};
}
