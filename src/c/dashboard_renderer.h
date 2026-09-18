#pragma once
#include "agent_ui_element.h"
#include "artwork_cache.h"

typedef enum {
  DashboardCalendar, DashboardWeather, DashboardTodos,
  DashboardSleep, DashboardThink, DashboardTimer, DashboardAlarm,
  DashboardIconCount
} DashboardIcon;

// Borrowed, read-only UI data. Only the dedicated artwork cache is mutable.
typedef struct {
 const AgentUiElement *elements;
 uint8_t element_count, request_frame;
 int16_t selected_element;
 GBitmap *const *dashboard_icons;
 ArtworkCache *artwork;
 int codex_active, codex_remaining;
} DashboardView;
GRect dashboard_frame(int16_t width,int16_t height,const char *id);
void dashboard_draw(const DashboardView *view,GContext *ctx);
