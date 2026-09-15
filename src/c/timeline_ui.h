#pragma once
#include <pebble.h>
#include "timeline_layout.h"

void timeline_ui_sidebar(GContext *ctx, GRect viewport);
void timeline_ui_day(GContext *ctx, GRect frame, const char *day);
void timeline_ui_card(GContext *ctx, GRect frame, const char *title,
                      const char *meta, bool expanded, bool cached);
void timeline_ui_relationship(GContext *ctx, int x, int y, const char *meta,
                              const char *next_meta);
void timeline_ui_detail_header(GContext *ctx, GRect frame, const char *title);
