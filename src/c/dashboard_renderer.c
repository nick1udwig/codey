#include "dashboard_renderer.h"
#include "dashboard_layout.h"
#include "agent_protocol.h"
#include <string.h>
#include <stdlib.h>
#define AGENT_MIN(a,b) ((a)<(b)?(a):(b))
#define AGENT_MAX(a,b) ((a)>(b)?(a):(b))
#define PAPER PBL_IF_COLOR_ELSE(GColorPastelYellow, GColorWhite)
#define ACCENT PBL_IF_COLOR_ELSE(GColorFolly, GColorWhite)

static GFont prv_font(DashboardFonts *fonts, DashboardFont font) {
#if defined(PBL_ROUND)
  static const uint32_t resources[] = {RESOURCE_ID_FONT_DASH_TIME_50,
    RESOURCE_ID_FONT_DASH_TEMPERATURE_38, RESOURCE_ID_FONT_DASH_SMALL_12,
    RESOURCE_ID_FONT_DASH_DATE_16, RESOURCE_ID_FONT_DASH_PREVIEW_18,
    RESOURCE_ID_FONT_DASH_LABEL_16, RESOURCE_ID_FONT_DASH_COUNT_24,
    RESOURCE_ID_FONT_DASH_RANGE_16};
#else
  static const uint32_t resources[] = {RESOURCE_ID_FONT_DASH_TIME_56,
    RESOURCE_ID_FONT_DASH_TEMPERATURE_44, RESOURCE_ID_FONT_DASH_SMALL_14,
    RESOURCE_ID_FONT_DASH_DATE_19, RESOURCE_ID_FONT_DASH_PREVIEW_21,
    RESOURCE_ID_FONT_DASH_LABEL_19, RESOURCE_ID_FONT_DASH_COUNT_28,
    RESOURCE_ID_FONT_DASH_RANGE_18};
#endif
  if (!fonts->slots[font]) fonts->slots[font] = fonts_load_custom_font(resource_get_handle(resources[font]));
  return fonts->slots[font];
}

GRect dashboard_frame(int16_t width, int16_t height, const char *id) {
  return dashboard_layout_frame(dashboard_bounds(width, height, PBL_IF_ROUND_ELSE(true, false)), id);
}

static void prv_text(DashboardFonts *fonts, GContext *ctx, const char *text,
                     DashboardFont font, GRect frame, GColor color, GTextAlignment alignment) {
  graphics_context_set_compositing_mode(ctx, GCompOpAssign);
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, prv_font(fonts, font), frame,
      GTextOverflowModeTrailingEllipsis, alignment, NULL);
}

static void prv_glyph(GContext *ctx, const char *pixels, int columns, int rows,
                      int x, int y, int scale, GColor color) {
  graphics_context_set_fill_color(ctx, color);
  for (int row = 0; row < rows; ++row)
    for (int col = 0; col < columns; ++col)
      if (pixels[row * columns + col] == '#')
        graphics_fill_rect(ctx, GRect(x + col * scale, y + row * scale, scale, scale), 0, GCornerNone);
}

static const char SUN[] = "....#...." ".#.....#." "...###..." "..#####.." "#.#####.#" "..#####.." "...###..." ".#.....#." "....#....";
static const char TIMER[] = "...###..." "....#...." "..#####.." ".#.....#." "#...#...#" "#...##..#" "#.......#" ".#.....#." "..#####..";
static const char BRAIN[] = "..##.##.." ".#..#..#." "#.#.#.#.#" "#...#...#" "#.#.#.#.#" ".#..#..#." "..##.##.." "....#....";
static const char BOX[] = "#######" "#.....#" "#....##" "#...#.#" "##.#..#" "#.#...#" "#######";
static const char NOTE[] = "#####.." "#...##." "#...###" "#.....#" "#.###.#" "#.....#" "#.###.#" "#.....#" "#######";
static const char CHECK[] = "........#" ".......##" "#.....##." "##...##.." ".##.##..." "..###...." "...#.....";
static const char ROBOT[] = "...#####..." "..#######.." ".###.#.###." ".###.#.###." ".#########." "###########" ".#########.";
static const char BELL[] = "....#...." "...###..." "..#####.." "..#...#.." "..#...#.." ".##...##." ".#######." "...###...";

static void prv_weather_icon(GContext *ctx, const char *icon, int x, int y) {
  if (!strcmp(icon, "sun")) { prv_glyph(ctx, SUN, 9, 9, x, y, 2, ACCENT); return; }
  bool moon = !strcmp(icon, "moon") || !strcmp(icon, "night-cloud");
  bool sun = !strcmp(icon, "partly-cloudy");
  graphics_context_set_fill_color(ctx, ACCENT);
  graphics_context_set_stroke_color(ctx, ACCENT);
  if (moon) {
    graphics_fill_circle(ctx, GPoint(x + 8, y + 8), 8);
    graphics_context_set_fill_color(ctx, PAPER);
    graphics_fill_circle(ctx, GPoint(x + 12, y + 4), 7);
  } else if (sun) prv_glyph(ctx, SUN, 9, 9, x, y, 2, ACCENT);
  if (!strcmp(icon, "moon")) return;
  if (!icon[0] || !strcmp(icon, "unknown")) {
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_draw_circle(ctx, GPoint(x + 9, y + 9), 7);
    graphics_draw_line(ctx, GPoint(x + 9, y + 5), GPoint(x + 9, y + 10));
    graphics_draw_pixel(ctx, GPoint(x + 9, y + 13));
    return;
  }
  graphics_context_set_fill_color(ctx, ACCENT);
  graphics_fill_circle(ctx, GPoint(x + 5, y + 12), 4);
  graphics_fill_circle(ctx, GPoint(x + 11, y + 10), 6);
  graphics_fill_circle(ctx, GPoint(x + 16, y + 13), 4);
  graphics_fill_rect(ctx, GRect(x + 3, y + 12, 16, 5), 0, GCornerNone);
  if (!strcmp(icon, "rain") || !strcmp(icon, "snow")) {
    for (int i = 0; i < 3; ++i) {
      int px = x + 4 + i * 6;
      graphics_draw_line(ctx, GPoint(px, y + 20), GPoint(px - 2, y + 24));
      if (!strcmp(icon, "snow")) graphics_draw_line(ctx, GPoint(px - 2, y + 20), GPoint(px, y + 24));
    }
  } else if (!strcmp(icon, "storm")) {
    graphics_draw_line(ctx, GPoint(x + 12, y + 18), GPoint(x + 8, y + 22));
    graphics_draw_line(ctx, GPoint(x + 8, y + 22), GPoint(x + 13, y + 22));
    graphics_draw_line(ctx, GPoint(x + 13, y + 22), GPoint(x + 9, y + 26));
  }
}
static void prv_dashboard_codey(const DashboardView *ui, GContext *ctx, GRect frame) {
#if defined(PBL_ROUND)
  uint32_t resource = ui->codex_active > 0 ? RESOURCE_ID_DASH_CODEY_THINK_GABBRO : RESOURCE_ID_DASH_CODEY_SLEEP_GABBRO;
#else
  uint32_t resource = ui->codex_active > 0 ? RESOURCE_ID_DASH_CODEY_THINK_EMERY : RESOURCE_ID_DASH_CODEY_SLEEP_EMERY;
#endif
  // Keep one cached compact 5b pose.
  GBitmap *bitmap = artwork_cache_get(ui->artwork, resource);
  if (!bitmap) return;
  GRect bounds = gbitmap_get_bounds(bitmap);
  graphics_context_set_compositing_mode(ctx, GCompOpSet);
  graphics_draw_bitmap_in_rect(ctx, bitmap,
      GRect(frame.origin.x + (frame.size.w - bounds.size.w) / 2,
            frame.origin.y + (frame.size.h - bounds.size.h) / 2, bounds.size.w, bounds.size.h));
}

void dashboard_draw_calendar(DashboardFonts *fonts, GContext *ctx, GRect f) {
  time_t now = time(NULL);
  struct tm *local = localtime(&now);
  char clock[12] = "--:--", date[24] = "", battery[8];
  if (local) {
    strftime(clock, sizeof(clock), clock_is_24h_style() ? "%H:%M" : "%I:%M", local);
    if (!clock_is_24h_style() && clock[0] == '0') memmove(clock, clock + 1, strlen(clock));
    char prefix[16];
    // Keep visible, nonbreaking spacing before the day so it cannot wrap below
    // the header during later redraws.
    strftime(prefix, sizeof(prefix), "%a,%b", local);
    snprintf(date, sizeof(date), "%s\xc2\xa0\xc2\xa0%d", prefix, local->tm_mday);
    for (char *p = date; *p; ++p) if (*p >= 'a' && *p <= 'z') *p -= 'a' - 'A';
  }
  int x = f.origin.x, y = f.origin.y, w = f.size.w;
  // Give the larger date its own row while keeping clock ink above the rule.
  int clock_height = PBL_IF_ROUND_ELSE(50, 56);
  int header_y = y + 1;
  prv_text(fonts, ctx, clock, DashboardFontTime,
      GRect(x + PBL_IF_ROUND_ELSE(4, 8), y + PBL_IF_ROUND_ELSE(6, 10),
          w - PBL_IF_ROUND_ELSE(4, 8), clock_height), GColorBlack, GTextAlignmentLeft);
  BatteryChargeState charge = battery_state_service_peek();
  snprintf(battery, sizeof(battery), "%d", charge.charge_percent);
  int bx = x + w - 32;
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_draw_rect(ctx, GRect(bx, header_y + 8, 12, 7));
  graphics_fill_rect(ctx, GRect(bx + 12, header_y + 10, 2, 3), 0, GCornerNone);
  graphics_fill_rect(ctx, GRect(bx + 2, header_y + 10, 8 * charge.charge_percent / 100, 3), 0, GCornerNone);
  prv_text(fonts, ctx, battery, DashboardFontSmall, GRect(bx + 16, header_y + 3, 16, 22), GColorBlack, GTextAlignmentLeft);
  prv_text(fonts, ctx, date, DashboardFontDate,
      GRect(x + 8, header_y, bx - x - 10, 26), GColorBlack, GTextAlignmentLeft);
}

static void prv_weather(const DashboardView *ui, GContext *ctx, const AgentUiElement *e) {
  GRect f = e->frame;
  char icon[24] = "", low[12] = "--", high[12] = "--", temperature[16];
  agent_protocol_meta_get(e->meta, "icon", icon, sizeof(icon));
  const char *split = !strncmp(e->subtitle, "L ", 2) ? strstr(e->subtitle + 2, " H ") : NULL;
  if (split) {
    size_t n = AGENT_MIN((size_t)(split - e->subtitle - 2), sizeof(low) - 1);
    memcpy(low, e->subtitle + 2, n); low[n] = 0;
    agent_protocol_copy(high, sizeof(high), split + 3);
  }
  // Units remain on the weather detail screen; the almanac uses a degree mark.
  const char *raw = e->value[0] ? e->value : "--";
  size_t n = strspn(raw, "0123456789-+");
  if (n && n < sizeof(temperature) - 3) snprintf(temperature, sizeof(temperature), "%.*s°", (int)n, raw);
  else agent_protocol_copy(temperature, sizeof(temperature), "--°");
  int x = f.origin.x, cy = f.origin.y + f.size.h / 2;
  prv_weather_icon(ctx, icon, x + 8, cy - 9);
  int range_width = 26, temp_width = f.size.w - 40 - range_width;
  GSize size = graphics_text_layout_get_content_size(temperature, prv_font(ui->fonts, DashboardFontTemperature),
      GRect(0, 0, 200, 60), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  DashboardFont font = size.w > temp_width ? DashboardFontCount : DashboardFontTemperature;
  int text_height = font == DashboardFontCount ? 34 : PBL_IF_ROUND_ELSE(46, 52);
  prv_text(ui->fonts, ctx, temperature, font, GRect(x + 34, cy - text_height / 2 - 2, temp_width, text_height), GColorBlack, GTextAlignmentLeft);
  int rx = x + f.size.w - range_width - 5;
  prv_glyph(ctx, "..#.." ".###." "#####", 5, 3, rx - 7, cy - 8, 1, GColorBlack);
  prv_glyph(ctx, "#####" ".###." "..#..", 5, 3, rx - 7, cy + 9, 1, GColorBlack);
  int range_y = cy - PBL_IF_ROUND_ELSE(16, 18);
  prv_text(ui->fonts, ctx, high, DashboardFontRange, GRect(rx, range_y, range_width, 26), GColorBlack, GTextAlignmentLeft);
  prv_text(ui->fonts, ctx, low, DashboardFontRange, GRect(rx, range_y + 17, range_width, 26), GColorBlack, GTextAlignmentLeft);
}

static void prv_tab(GContext *ctx, GRect f, bool selected, const char *pixels, int columns, int rows) {
  graphics_context_set_fill_color(ctx, selected ? GColorBlack : PAPER);
  graphics_fill_rect(ctx, f, 0, GCornerNone);
  graphics_context_set_stroke_color(ctx, selected ? GColorBlack : GColorDarkGray);
  graphics_draw_rect(ctx, f);
  prv_glyph(ctx, pixels, columns, rows, f.origin.x + (f.size.w - columns) / 2,
      f.origin.y + (f.size.h - rows) / 2, 1, selected ? GColorWhite : GColorDarkGray);
}

static void prv_collection(const DashboardView *ui, GContext *ctx, const AgentUiElement *e) {
  GRect f = e->frame;
  int tab_width = PBL_IF_ROUND_ELSE(14, 15), tab_height = PBL_IF_ROUND_ELSE(12, 13);
  int tabs_y = f.origin.y + f.size.h / 2 + 6;
  prv_text(ui->fonts, ctx, e->value[0] ? e->value : "0", DashboardFontCount,
      GRect(f.origin.x, tabs_y - 36, f.size.w, 34), GColorBlack, GTextAlignmentCenter);
  int selected = !strcmp(e->action, "local.notes") ? 1 : !strcmp(e->action, "local.checks") ? 2 : 0;
  int x = dashboard_row_left(f, 3, tab_width, 2);
  const char *pixels[] = {BOX, NOTE, CHECK};
  const int columns[] = {7, 7, 9}, rows[] = {7, 9, 7};
  for (int i = 0; i < 3; ++i)
    prv_tab(ctx, GRect(x + i * (tab_width + 2), tabs_y, tab_width, tab_height),
        selected == i, pixels[i], columns[i], rows[i]);
}

static void prv_jobs(const DashboardView *ui, GContext *ctx, GRect f) {
  const AgentUiElement *items[AGENT_UI_MAX_ELEMENTS];
  const AgentUiElement *tour = NULL;
  int count = 0, jobs = 0;
  for (int i = 0; i < ui->element_count; ++i) {
    const AgentUiElement *e = &ui->elements[i];
    if (!e->used) continue;
    if (!strcmp(e->action, "local.tour")) { tour = e; continue; }
    if (!strncmp(e->id, "schedule-", 9) || !strcmp(e->id, "dashboard-stopwatch") ||
        !strcmp(e->action, "local.job.open")) items[count++] = e;
    if (!strcmp(e->action, "local.job.open")) ++jobs;
  }
  if (!count && tour) items[count++] = tour;
  // Active timer detail takes priority; the complete list keeps its ordering.
  for (int i = 0; i < count; ++i) {
    char kind[16] = "";
    agent_protocol_meta_get(items[i]->meta, "dashboard_kind", kind, sizeof(kind));
    if (!strcmp(kind, "timer")) {
      const AgentUiElement *first = items[i]; items[i] = items[0]; items[0] = first;
      break;
    }
  }
  int cx = f.origin.x + f.size.w / 2, cy = f.origin.y + f.size.h / 2;
  if (!count) { prv_glyph(ctx, TIMER, 9, 9, cx - 9, cy - 9, 2, GColorDarkGray); return; }
  const AgentUiElement *first = items[0];
  char kind[16] = "", label[24];
  agent_protocol_meta_get(first->meta, "dashboard_kind", kind, sizeof(kind));
  bool timer = !strcmp(kind, "timer");
  if (timer) {
    // Duration text begins with the bounded native H:MM:SS or M:SS value.
    size_t n = strcspn(first->subtitle, " ");
    snprintf(label, sizeof(label), "%.*s", (int)AGENT_MIN(n, sizeof(label) - 1), first->subtitle);
    if (!strcmp(label, "Finished")) agent_protocol_copy(label, sizeof(label), "0:00");
    // Keep multi-hour timers readable in the narrow key cap.
    char *colon = strchr(label, ':');
    if (colon && strchr(colon + 1, ':')) {
      char hours[12]; snprintf(hours, sizeof(hours), "%.*sh", (int)(colon - label), label);
      agent_protocol_copy(label, sizeof(label), hours);
    }
  } else if (!strcmp(first->action, "local.tour")) agent_protocol_copy(label, sizeof(label), "Start");
  else if (!strcmp(kind, "job")) snprintf(label, sizeof(label), "%d run%s", jobs, jobs == 1 ? "" : "s");
  else agent_protocol_copy(label, sizeof(label), !strcmp(first->id, "dashboard-stopwatch") ? first->subtitle : "Alarm");
  if (timer) {
    GRect ring = GRect(f.origin.x + 7, cy - 15, 14, 14);
    int progress = AGENT_MAX(0, AGENT_MIN(100, agent_protocol_meta_get_int(first->meta, "progress", 0)));
    graphics_context_set_fill_color(ctx, ACCENT);
    graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, 1, 0, TRIG_MAX_ANGLE);
    if (progress) graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, 7, 0,
        (int32_t)((int64_t)TRIG_MAX_ANGLE * progress / 100));
  }
  prv_text(ui->fonts, ctx, label, DashboardFontLabel,
      GRect(f.origin.x + (timer ? 24 : 4), cy - 23, f.size.w - (timer ? 26 : 8), 26), GColorBlack,
      timer ? GTextAlignmentLeft : GTextAlignmentCenter);
  int shown = AGENT_MIN(count, 3), x = dashboard_row_left(f, shown, 16, 2);
  for (int i = 0; i < shown; ++i) {
    char type[16] = "";
    agent_protocol_meta_get(items[i]->meta, "dashboard_kind", type, sizeof(type));
    bool job = !strcmp(type, "job") || !strcmp(items[i]->action, "local.tour");
    bool alarm = !strcmp(type, "alarm");
    prv_tab(ctx, GRect(x + i * 18, cy + 9, 16, 12), i == 0,
        job ? ROBOT : alarm ? BELL : TIMER, job ? 11 : 9, alarm ? 8 : job ? 7 : 9);
  }
}

void dashboard_draw(const DashboardView *ui, GContext *ctx) {
  GRect board = dashboard_bounds(ui->width, ui->height, PBL_IF_ROUND_ELSE(true, false));
  graphics_context_set_fill_color(ctx, PAPER);
  graphics_fill_rect(ctx, board, 0, GCornerNone);
  // Thin rules divide the left-hand almanac into date/time, weather, and preview.
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_stroke_width(ctx, 1);
  for (int row = 1; row <= 2; ++row) {
    GRect line = dashboard_layout_rect(board, 0, row * 76, 136, 1);
    graphics_draw_line(ctx, line.origin, GPoint(line.origin.x + line.size.w - 1, line.origin.y));
  }
  for (int i = 0; i < ui->element_count; ++i) {
    const AgentUiElement *e = &ui->elements[i];
    if (!e->used || !e->frame.size.h) continue;
    GRect f = e->frame;
    bool cap = !strcmp(e->id, "dashboard-summary") || !strcmp(e->id, "dictate") || !strcmp(e->id, "todos");
    bool selected = ui->selected_element == i;
    if (cap) {
      graphics_context_set_stroke_color(ctx, GColorBlack);
      graphics_draw_round_rect(ctx, grect_inset(f, GEdgeInsets(1)), PBL_IF_ROUND_ELSE(10, 12));
    } else if (selected) {
      graphics_context_set_fill_color(ctx, GColorLightGray);
      graphics_fill_rect(ctx, f, 0, GCornerNone);
    }
    if (!strcmp(e->id, "weather")) prv_weather(ui, ctx, e);
    else if (!strcmp(e->id, "collection-preview")) {
      GRect text = GRect(f.origin.x + 8, f.origin.y, f.size.w - 16, f.size.h);
      GSize size = graphics_text_layout_get_content_size(e->value, prv_font(ui->fonts, DashboardFontPreview),
          text, GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);
      text.origin.y += AGENT_MAX(0, (text.size.h - size.h) / 2 - 3);
      text.size.h = AGENT_MIN(text.size.h, size.h + 8);
      prv_text(ui->fonts, ctx, e->value, DashboardFontPreview, text, GColorBlack, GTextAlignmentLeft);
    } else if (!strcmp(e->id, "dashboard-summary")) prv_jobs(ui, ctx, f);
    else if (!strcmp(e->id, "todos")) prv_collection(ui, ctx, e);
    else if (!strcmp(e->id, "dictate")) {
      int quota_height = PBL_IF_ROUND_ELSE(18, 20);
      GRect mascot = f; mascot.origin.y += 3; mascot.size.h -= quota_height + 3;
      prv_dashboard_codey(ui, ctx, mascot);
      char quota[8];
      if (ui->codex_remaining < 0) agent_protocol_copy(quota, sizeof(quota), "--");
      else snprintf(quota, sizeof(quota), "%d", ui->codex_remaining);
      GSize size = graphics_text_layout_get_content_size(quota, prv_font(ui->fonts, DashboardFontSmall),
          GRect(0, 0, 40, 24), GTextOverflowModeWordWrap, GTextAlignmentLeft);
      int x = f.origin.x + (f.size.w - size.w - 12) / 2, y = f.origin.y + f.size.h - quota_height;
      prv_glyph(ctx, BRAIN, 9, 8, x, y + 6, 1, GColorBlack);
      prv_text(ui->fonts, ctx, quota, DashboardFontSmall, GRect(x + 12, y + 2, size.w + 2, quota_height), GColorBlack, GTextAlignmentLeft);
    }
  }
}
