#pragma once
#include <stdint.h>
static inline int32_t range_quantize(int64_t value, int32_t min, int32_t max, int32_t step) {
  if (value <= min) { return min; }
  if (value >= max) { return max; }
  if (step < 1) { step = 1; }
  int64_t result = min + ((value - min + step / 2) / step) * step;
  return result > max ? max : (int32_t)result;
}
static inline int32_t range_slider(int32_t x, int32_t width, int32_t min, int32_t max, int32_t step) {
  if (width < 1) { return min; }
  return range_quantize(min + (int64_t)x * (max - min) / width, min, max, step);
}
static inline int32_t range_angle_delta(int32_t angle, int32_t previous) {
  int32_t delta = angle - previous;
  if (delta > 32768) { delta -= 65536; }
  if (delta < -32768) { delta += 65536; }
  return delta;
}
