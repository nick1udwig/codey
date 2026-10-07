#pragma once
#include "agent_ui_element.h"
#include "artwork_cache.h"

typedef enum {
  DashboardFontTime, DashboardFontTemperature, DashboardFontSmall,
  DashboardFontDate, DashboardFontPreview, DashboardFontLabel, DashboardFontCount,
  DashboardFontCountTotal
} DashboardFont;
typedef struct { GFont slots[DashboardFontCountTotal]; } DashboardFonts;
static inline void dashboard_fonts_clear(DashboardFonts *fonts) {
  for (int i = 0; i < DashboardFontCountTotal; ++i) {
    if (fonts->slots[i]) fonts_unload_custom_font(fonts->slots[i]);
    fonts->slots[i] = NULL;
  }
}

// Borrowed UI data with bounded, mutable artwork and font caches.
typedef struct {
 const AgentUiElement *elements;
 uint8_t element_count, request_frame;
 int16_t selected_element;
 ArtworkCache *artwork;
 DashboardFonts *fonts;
 int16_t width, height;
 int codex_active, codex_remaining;
} DashboardView;
GRect dashboard_frame(int16_t width,int16_t height,const char *id);
void dashboard_draw(const DashboardView *view,GContext *ctx);
void dashboard_draw_calendar(DashboardFonts *fonts, GContext *ctx, GRect frame);
