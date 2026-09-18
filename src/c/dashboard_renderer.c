#include "dashboard_renderer.h"
#include "agent_protocol.h"
#include "../../resources/images/pixel-font-5x7.h"
#include <string.h>
#include <stdlib.h>
#define AGENT_MIN(a,b) ((a)<(b)?(a):(b))
#define AGENT_MAX(a,b) ((a)>(b)?(a):(b))

static GRect prv_dashboard_bounds(int16_t width,int16_t height) {
#if defined(PBL_ROUND)
  // A centered inscribed square keeps every corner within the circular glass.
  int16_t side = AGENT_MIN(width, height) * 69 / 100;
  return GRect((width - side) / 2, (height - side) / 2, side, side);
#else
  return GRect(4, 4, width - 8, height - 8);
#endif
}

GRect dashboard_frame(int16_t width,int16_t height, const char *id) {
  GRect board = prv_dashboard_bounds(width,height);
  int16_t gap = 3, left = (board.size.w - gap) * 53 / 100;
  int16_t right = board.size.w - left - gap, x = board.origin.x, y = board.origin.y;
  int16_t calendar = (board.size.h - gap) * 66 / 100;
  int16_t notifications = board.size.h * 44 / 100;
  int16_t talk = board.size.h * 36 / 100 + gap;
  if (strcmp(id, "calendar") == 0) { return GRect(x, y, left, calendar); }
  if (strcmp(id, "weather") == 0) { return GRect(x, y + calendar + gap, left, board.size.h - calendar - gap); }
  x += left + gap;
  if (strcmp(id, "dashboard-summary") == 0) { return GRect(x, y, right, notifications); }
  y += notifications + gap;
  if (strcmp(id, "dictate") == 0) { return GRect(x, y, right, talk); }
  y += talk + gap;
  if (strcmp(id, "todos") == 0) { return GRect(x, y, right, board.origin.y + board.size.h - y); }
  return GRectZero;
}

static void prv_draw_text(GContext *ctx, const char *text, GFont font, GRect frame,
                          GTextAlignment alignment, GColor color, GTextOverflowMode overflow) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text ? text : "", font, frame, overflow, alignment, NULL);
}

static void prv_pixel_panel(GContext *ctx, GRect f, GColor color) {
  graphics_context_set_fill_color(ctx, color);
  graphics_fill_rect(ctx, GRect(f.origin.x + 4, f.origin.y, f.size.w - 8, f.size.h), 0, GCornerNone);
  graphics_fill_rect(ctx, GRect(f.origin.x + 2, f.origin.y + 2, f.size.w - 4, f.size.h - 4), 0, GCornerNone);
  graphics_fill_rect(ctx, GRect(f.origin.x, f.origin.y + 4, f.size.w, f.size.h - 8), 0, GCornerNone);
}

static void prv_dashboard_card(GContext *ctx, GRect frame, bool blue, bool selected) {
  GColor accent = PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorWhite);
  prv_pixel_panel(ctx, frame, selected ? accent : GColorLightGray);
  prv_pixel_panel(ctx, grect_inset(frame, GEdgeInsets(2)), blue ? PBL_IF_COLOR_ELSE(GColorBlue, GColorBlack) : GColorWhite);
  if (selected) {
    graphics_context_set_stroke_color(ctx, blue ? GColorWhite : GColorBlack);
    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_rect(ctx, grect_inset(frame, GEdgeInsets(3)));
  }
}

static void prv_pixel_text(GContext *ctx, const char *text, int16_t x, int16_t y,
                           int sx, int sy, GColor color) {
  graphics_context_set_fill_color(ctx, color);
  for (; *text; ++text, x += 6 * sx) {
    char letter = *text >= 'a' && *text <= 'z' ? *text - 'a' + 'A' : *text;
    const char *glyph = strchr(DASH_PIXEL_FONT_CHARS, letter);
    if (!glyph) { continue; }
    const uint8_t *rows = DASH_PIXEL_FONT_5X7[glyph - DASH_PIXEL_FONT_CHARS];
    for (int row = 0; row < 7; ++row) {
      for (int column = 0; column < 5; ++column) {
        if (rows[row] & (1 << (4 - column))) {
          graphics_fill_rect(ctx, GRect(x + column * sx, y + row * sy, sx, sy), 0, GCornerNone);
        }
      }
    }
  }
}

static void prv_dashboard_icon(const DashboardView *ui, GContext *ctx, DashboardIcon icon, int16_t x, int16_t y) {
  if (!ui->dashboard_icons[icon]) { return; }
  graphics_context_set_compositing_mode(ctx, GCompOpSet);
  int size = icon >= DashboardSleep ? 20 : 24;
  graphics_draw_bitmap_in_rect(ctx, ui->dashboard_icons[icon], GRect(x, y, size, size));
}

static void prv_weather_icon(const DashboardView *ui, GContext *ctx, const char *icon, int16_t x, int16_t y) {
  bool moon = strcmp(icon, "moon") == 0 || strcmp(icon, "night-cloud") == 0;
  bool sun = strcmp(icon, "sun") == 0 || strcmp(icon, "partly-cloudy") == 0;
  bool cloud = strcmp(icon, "sun") != 0 && strcmp(icon, "moon") != 0;
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  if (strcmp(icon, "unknown") == 0 || !icon[0]) { prv_dashboard_icon(ui, ctx, DashboardWeather, x, y); return; }
  if (moon) {
    graphics_fill_circle(ctx, GPoint(x + 10, y + 9), 8);
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_circle(ctx, GPoint(x + 14, y + 5), 7);
    graphics_context_set_fill_color(ctx, GColorBlack);
  } else if (sun) {
    graphics_fill_circle(ctx, GPoint(x + 11, y + 10), 5);
    for (int i = 0; i < 8; ++i) {
      int angle = i * TRIG_MAX_ANGLE / 8;
      int dx = sin_lookup(angle), dy = cos_lookup(angle);
      graphics_draw_line(ctx, GPoint(x + 11 + dx * 8 / TRIG_MAX_RATIO, y + 10 + dy * 8 / TRIG_MAX_RATIO),
                         GPoint(x + 11 + dx * 11 / TRIG_MAX_RATIO, y + 10 + dy * 11 / TRIG_MAX_RATIO));
    }
  }
  if (cloud) {
    graphics_fill_circle(ctx, GPoint(x + 7, y + 15), 5);
    graphics_fill_circle(ctx, GPoint(x + 14, y + 12), 7);
    graphics_fill_circle(ctx, GPoint(x + 20, y + 16), 4);
    graphics_fill_rect(ctx, GRect(x + 5, y + 15, 17, 5), 0, GCornerNone);
    if (strcmp(icon, "rain") == 0 || strcmp(icon, "snow") == 0) {
      for (int i = 0; i < 3; ++i) {
        int px = x + 6 + i * 7;
        graphics_draw_line(ctx, GPoint(px, y + 23), GPoint(px - 2, y + 27));
        if (strcmp(icon, "snow") == 0) { graphics_draw_line(ctx, GPoint(px - 2, y + 23), GPoint(px, y + 27)); }
      }
    } else if (strcmp(icon, "storm") == 0) {
      graphics_draw_line(ctx, GPoint(x + 14, y + 21), GPoint(x + 10, y + 25));
      graphics_draw_line(ctx, GPoint(x + 10, y + 25), GPoint(x + 15, y + 25));
      graphics_draw_line(ctx, GPoint(x + 15, y + 25), GPoint(x + 11, y + 29));
    }
  }
}

// Use native font proportions. Width (including two three-digit values and
// the percent sign) determines the largest font that fits this telemetry row.
static GFont prv_dashboard_metric_font(GRect b) {
  const char *keys[] = { FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_GOTHIC_24_BOLD,
                         FONT_KEY_GOTHIC_18_BOLD, FONT_KEY_GOTHIC_14_BOLD };
  int available_height = (b.size.h - 42) / 2 - 12;
  for (unsigned i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
    GFont font = fonts_get_system_font(keys[i]);
    GSize digits = graphics_text_layout_get_content_size("100", font, GRect(0,0,200,60),
        GTextOverflowModeWordWrap, GTextAlignmentLeft);
    GSize percent = graphics_text_layout_get_content_size("%", font, GRect(0,0,200,60),
        GTextOverflowModeWordWrap, GTextAlignmentLeft);
    if (2 * digits.w + percent.w + 8 <= b.size.w - 42 &&
        digits.h <= available_height) { return font; }
  }
  return fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
}

// Small hand-drawn pictographs avoid relying on missing emoji font glyphs.
static void prv_dashboard_battery(GContext *ctx,GRect b) {
  int x=b.origin.x+5,y=b.origin.y+7;
  graphics_context_set_stroke_color(ctx,GColorBlack);graphics_context_set_fill_color(ctx,GColorBlack);
  BatteryChargeState battery=battery_state_service_peek();
  graphics_draw_rect(ctx,GRect(x,y+4,11,7));graphics_fill_rect(ctx,GRect(x+11,y+6,2,3),0,GCornerNone);
  graphics_fill_rect(ctx,GRect(x+2,y+6,7*battery.charge_percent/100,3),0,GCornerNone);
  char text[16];snprintf(text,sizeof(text),"%d",battery.charge_percent);
  GFont font = prv_dashboard_metric_font(b);
  prv_draw_text(ctx,text,font,GRect(x+15,b.origin.y+5,(b.size.w-42)/2,30),
                GTextAlignmentLeft,GColorBlack,GTextOverflowModeTrailingEllipsis);
}

static void prv_dashboard_quota(const DashboardView *ui,GContext *ctx,GRect b) {
  int x=b.origin.x+b.size.w-19,y=b.origin.y+7;
  char text[16];
  // Scalloped brain silhouette and short folds remain readable at 14 pixels.
  graphics_context_set_fill_color(ctx,PBL_IF_COLOR_ELSE(GColorMelon,GColorWhite));
  graphics_fill_circle(ctx,GPoint(x+4,y+4),3);
  graphics_fill_circle(ctx,GPoint(x+10,y+4),3);
  graphics_fill_circle(ctx,GPoint(x+3,y+8),3);
  graphics_fill_circle(ctx,GPoint(x+11,y+8),3);
  graphics_fill_circle(ctx,GPoint(x+5,y+10),3);
  graphics_fill_circle(ctx,GPoint(x+9,y+10),3);
  graphics_context_set_stroke_color(ctx,GColorBlack);
  graphics_draw_line(ctx,GPoint(x+7,y+2),GPoint(x+7,y+12));
  graphics_draw_line(ctx,GPoint(x+2,y+6),GPoint(x+4,y+7));
  graphics_draw_line(ctx,GPoint(x+10,y+7),GPoint(x+12,y+6));
  if(ui->codex_remaining<0)snprintf(text,sizeof(text),"--");else snprintf(text,sizeof(text),"%d",ui->codex_remaining);
  GFont font = prv_dashboard_metric_font(b);
  int width = (b.size.w-42)/2;
  prv_draw_text(ctx,text,font,GRect(x-3-width,b.origin.y+5,width,30),
                GTextAlignmentRight,GColorBlack,GTextOverflowModeTrailingEllipsis);
  prv_draw_text(ctx,"%",font,GRect(b.origin.x+20,b.origin.y+5,b.size.w-42,30),
                GTextAlignmentCenter,GColorBlack,GTextOverflowModeTrailingEllipsis);
}

// Select the artwork from the active-thread count, including notification marks.
static DashboardIcon prv_codey_icon(const DashboardView *ui) {
  return ui->codex_active > 0 ? DashboardThink : DashboardSleep;
}

static void prv_dashboard_codey(const DashboardView *ui, GContext *ctx, GRect frame) {
  bool working = ui->codex_active > 0;
#if defined(PBL_ROUND)
  uint32_t resource = working ? RESOURCE_ID_DASH_CODEY_THINK_GABBRO : RESOURCE_ID_DASH_CODEY_SLEEP_GABBRO;
#else
  uint32_t resource = working ? RESOURCE_ID_DASH_CODEY_THINK_EMERY : RESOURCE_ID_DASH_CODEY_SLEEP_EMERY;
#endif
  if (ui->request_frame) {
    GBitmap *bitmap=artwork_cache_get(ui->artwork,resource);
    if (bitmap) {
      GRect bounds=gbitmap_get_bounds(bitmap);
      GRect target=GRect(frame.origin.x+(frame.size.w-bounds.size.w)/2,
                        frame.origin.y+(frame.size.h-bounds.size.h)/2,bounds.size.w,bounds.size.h);
      graphics_context_set_compositing_mode(ctx,GCompOpSet);
      graphics_draw_bitmap_in_rect(ctx,bitmap,target);
      return;
    }
  }
  // Native 4-bit PBI resources: 12-byte header, padded rows, then 16 colors.
  // Stream one row at a time to keep the full-button artwork off the tight heap.
  ResHandle handle = resource_get_handle(resource);
  uint16_t header[6];
  if (resource_load_byte_range(handle, 0, (uint8_t *)header, sizeof(header)) != sizeof(header)) { return; }
  int stride = header[0], width = header[4], height = header[5];
  GColor palette[16];
  if (resource_load_byte_range(handle, 12 + stride * height, (uint8_t *)palette, sizeof(palette)) != sizeof(palette)) { return; }
  GBitmap *row = gbitmap_create_blank_with_palette(GSize(width, 1), GBitmapFormat4BitPalette, palette, false);
  if (!row) { return; }
  if (gbitmap_get_bytes_per_row(row) != stride) { gbitmap_destroy(row); return; }
  int x = frame.origin.x + (frame.size.w - width) / 2;
  int y = frame.origin.y + (frame.size.h - height) / 2;
  graphics_context_set_compositing_mode(ctx, GCompOpSet);
  for (int line = 0; line < height; ++line) {
    if (resource_load_byte_range(handle, 12 + line * stride, gbitmap_get_data(row), stride) != (size_t)stride) { break; }
    graphics_draw_bitmap_in_rect(ctx, row, GRect(x, y + line, width, 1));
  }
  gbitmap_destroy(row);
}

// Use the larger font only when the complete line fits on one row.
static GFont prv_dashboard_label_font(const char *text, int width) {
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GSize size = graphics_text_layout_get_content_size(text, font, GRect(0,0,width,40),
      GTextOverflowModeWordWrap, GTextAlignmentCenter);
  return size.h <= 22 ? font : fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
}

void dashboard_draw(const DashboardView *ui, GContext *ctx) {
  time_t now = time(NULL);
  struct tm *local = localtime(&now);
  char clock_text[12] = "--:--", day[12] = "", date[16] = "", period[8] = "";
  if (local) {
    strftime(clock_text, sizeof(clock_text), clock_is_24h_style() ? "%H:%M" : "%I:%M", local);
    if (!clock_is_24h_style() && clock_text[0] == '0') {
      memmove(clock_text, clock_text + 1, strlen(clock_text));
    }
    strftime(day, sizeof(day), "%a", local);
    strftime(date, sizeof(date), "%b %d", local);
    if (!clock_is_24h_style()) { strftime(period, sizeof(period), "%p", local); }
  }
  for (uint8_t i = 0; i < ui->element_count; ++i) {
    const AgentUiElement *e = &ui->elements[i];
    if (!e->used || !e->frame.size.h) { continue; }
    GRect f = e->frame;
    int16_t x = f.origin.x, y = f.origin.y, w = f.size.w, h = f.size.h;
    bool blue = strcmp(e->id, "dictate") == 0 || strcmp(e->id, "new-chat") == 0;
    prv_dashboard_card(ctx, f, blue, ui->selected_element == i);
    if (strcmp(e->id, "calendar") == 0) {
      prv_dashboard_battery(ctx,f);
      prv_dashboard_quota(ui,ctx,f);
      int scale = AGENT_MAX(1, AGENT_MIN(3,(w-8)/((int)strlen(clock_text)*6-1)));
      int clock_width=((int)strlen(clock_text)*6-1)*scale;
      int clock_height=42;
      prv_pixel_text(ctx,clock_text,x+(w-clock_width)/2,y+(h-clock_height)/2-3,scale,6,GColorBlack);
      prv_pixel_text(ctx,period,x+w-19,y+(h+clock_height)/2-3,1,1,GColorBlack);
      char date_line[32];snprintf(date_line,sizeof(date_line),"%s %s",day,date);
      prv_draw_text(ctx,date_line,prv_dashboard_label_font(date_line,w-6),GRect(x+3,y+h-25,w-6,23),GTextAlignmentCenter,GColorBlack,GTextOverflowModeTrailingEllipsis);
    } else if (strcmp(e->id, "dashboard-summary") == 0) {
      prv_pixel_text(ctx, "NOTIFICATIONS", x + (w - 77) / 2, y + 7, 1, 1, GColorBlack);
      const AgentUiElement *items[AGENT_UI_MAX_ELEMENTS];
      int count = 0;
      for (uint8_t j = 0; j < ui->element_count; ++j) {
        const AgentUiElement *item = &ui->elements[j];
        if (item->used && (strncmp(item->id, "schedule-", 9) == 0 ||
            strcmp(item->id, "dashboard-stopwatch") == 0 || strcmp(item->action, "local.job.open") == 0 || strcmp(item->action, "local.tour") == 0)) { items[count++] = item; }
      }
      // Reserve enough height for each icon and label below the title.
      // Additional records remain available in the complete Notifications list.
      int capacity = h - 20 >= 68 ? 4 : 2;
      int shown = AGENT_MIN(count, capacity);
      int columns = count == 1 ? 1 : 2;
      int rows = shown <= 2 ? 1 : 2;
      int row_height = (h - 20) / rows;
      for (int item = 0; item < shown; ++item) {
        int cell_width = (w - 6) / columns;
        int16_t cx = x + 3 + cell_width * (item % columns) + cell_width / 2;
        int16_t cy = y + 18 + (item / columns) * row_height;
        if (count > capacity && item == capacity - 1) {
          char more[20];
          snprintf(more, sizeof(more), "%d MORE", count - capacity + 1);
          prv_pixel_text(ctx, more, cx - ((int)strlen(more) * 6 - 1) / 2,
                         cy + row_height / 2 - 3, 1, 1, GColorBlack);
          continue;
        }
        int diameter = AGENT_MIN(32, row_height - 10);
        GRect ring = GRect(cx - diameter / 2, cy, diameter, diameter);
        char kind[16] = "";
        agent_protocol_meta_get(items[item]->meta, "dashboard_kind", kind, sizeof(kind));
        bool timer = strcmp(kind, "timer") == 0;
        if (timer) {
          int progress = AGENT_MAX(0, AGENT_MIN(100, agent_protocol_meta_get_int(items[item]->meta, "progress", 0)));
          graphics_context_set_fill_color(ctx, GColorLightGray);
          graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, 3, 0, TRIG_MAX_ANGLE);
          if (progress > 0) {
            graphics_context_set_fill_color(ctx, GColorBlack);
            graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, 3, 0,
                                 (int32_t)((int64_t)TRIG_MAX_ANGLE * progress / 100));
          }
        }
        // The compact timer mark leaves the progress ring unobstructed.
        if (timer) {
          graphics_context_set_stroke_color(ctx, GColorBlack);
          graphics_context_set_stroke_width(ctx, 1);
          GPoint center = GPoint(cx, cy + diameter / 2);
          graphics_draw_circle(ctx, center, 4);
          graphics_draw_line(ctx, center, GPoint(cx, center.y - 3));
          graphics_draw_line(ctx, GPoint(cx - 2, center.y - 6), GPoint(cx + 2, center.y - 6));
        } else {
          prv_dashboard_icon(ui, ctx, strcmp(kind, "job") == 0 ? prv_codey_icon(ui) : strcmp(items[item]->id, "dashboard-stopwatch") == 0 ? DashboardTimer : DashboardAlarm,
                             cx - 10, cy + (diameter - 20) / 2);
        }
        char label[16];
        int max_chars = AGENT_MIN((int)sizeof(label) - 1, (cell_width - 2) / 6);
        agent_protocol_copy(label, max_chars + 1, items[item]->title);
        if ((int)strlen(items[item]->title) > max_chars && max_chars > 0) { label[max_chars - 1] = '.'; }
        prv_pixel_text(ctx, label, cx - ((int)strlen(label) * 6 - 1) / 2,
                       cy + diameter + 2, 1, 1, GColorBlack);
      }
    } else if (strcmp(e->id, "dictate") == 0) {
      prv_dashboard_codey(ui,ctx,f);

    } else if (strcmp(e->id, "weather") == 0) {
      char icon[24],low[12]="--",high[12]="--",label[20];
      agent_protocol_meta_get(e->meta,"icon",icon,sizeof(icon));
      const char *range=e->subtitle;
      if(!strncmp(range,"L ",2)) {
        const char *split=strstr(range+2," H ");
        if(split){size_t n=AGENT_MIN((size_t)(split-range-2),sizeof(low)-1);memcpy(low,range+2,n);low[n]=0;agent_protocol_copy(high,sizeof(high),split+3);}
      }
      snprintf(label,sizeof(label),"H %s",high);
      prv_draw_text(ctx,label,prv_dashboard_label_font(label,w-6),GRect(x+3,y-1,w-6,23),GTextAlignmentCenter,GColorBlack,GTextOverflowModeTrailingEllipsis);
      const char *temperature=e->value[0]?e->value:"--";
      int scale=strlen(temperature)<=4?2:1;
      int combined=26+((int)strlen(temperature)*6-1)*scale;
      int left=x+(w-combined)/2;
      prv_weather_icon(ui,ctx,icon,left,y+(h-24)/2);
      prv_pixel_text(ctx,temperature,left+26,y+(h-21)/2,scale,3,GColorBlack);
      snprintf(label,sizeof(label),"L %s",low);
      prv_draw_text(ctx,label,prv_dashboard_label_font(label,w-6),GRect(x+3,y+h-23,w-6,23),GTextAlignmentCenter,GColorBlack,GTextOverflowModeTrailingEllipsis);
    } else if (strcmp(e->id, "todos") == 0) {
      bool notes = strcmp(e->action, "local.notes") == 0;
      if (notes) {
        graphics_context_set_stroke_color(ctx, GColorBlack);
        graphics_context_set_stroke_width(ctx, 2);
        graphics_draw_rect(ctx, GRect(x+9,y+(h-22)/2,17,22));
        for (int line=0;line<3;line++) graphics_draw_line(ctx,GPoint(x+12,y+(h-22)/2+6+line*5),GPoint(x+23,y+(h-22)/2+6+line*5));
        graphics_context_set_stroke_width(ctx, 1);
      } else prv_dashboard_icon(ui, ctx, !strcmp(e->action,"local.events") ? DashboardCalendar : DashboardTodos, x + 5, y + (h - 24) / 2);
      char label[16];
      snprintf(label, sizeof(label), "%s %s", e->value[0] ? e->value : "0", !strcmp(e->action,"local.events") ? "EVENT" : notes ? "NOTE" : "TODO");
      prv_pixel_text(ctx, label, x + 32, y + (h - 7) / 2, 1, 1, GColorBlack);
    }
  }
}

