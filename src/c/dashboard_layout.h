#pragma once
#include <pebble.h>
#include <string.h>

// Design 5b uses a 200 x 228 canvas. Round watches keep its controls inside
// a centered square, with the three key caps aligned to the physical buttons.
static inline GRect dashboard_bounds(int16_t width, int16_t height, bool round) {
  if (!round) return GRect(0, 0, width, height);
  int16_t side = (width < height ? width : height) * 69 / 100;
  return GRect((width - side) / 2, (height - side) / 2, side, side);
}

static inline GRect dashboard_layout_rect(GRect board, int x, int y, int w, int h) {
  int left = x * board.size.w / 200, top = y * board.size.h / 228;
  return GRect(board.origin.x + left, board.origin.y + top,
      (x + w) * board.size.w / 200 - left,
      (y + h) * board.size.h / 228 - top);
}

static inline GRect dashboard_layout_frame(GRect board, const char *id) {
  if (!strcmp(id, "calendar")) return dashboard_layout_rect(board, 0, 0, 136, 76);
  if (!strcmp(id, "weather")) return dashboard_layout_rect(board, 0, 77, 136, 75);
  if (!strcmp(id, "collection-preview")) return dashboard_layout_rect(board, 0, 153, 136, 75);
  if (!strcmp(id, "dashboard-summary")) return dashboard_layout_rect(board, 138, 4, 62, 68);
  if (!strcmp(id, "dictate")) return dashboard_layout_rect(board, 138, 80, 62, 68);
  if (!strcmp(id, "todos")) return dashboard_layout_rect(board, 138, 156, 62, 68);
  return GRectZero;
}

static inline int dashboard_row_left(GRect frame, int count, int width, int gap) {
  int extent = count * width + (count - 1) * gap;
  return frame.origin.x + frame.size.w / 2 - extent / 2;
}
