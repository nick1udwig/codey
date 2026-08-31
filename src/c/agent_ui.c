#include "agent_ui.h"

#include "agent_protocol.h"

#include <stdlib.h>
#include <string.h>

#ifndef AGENT_MAX
#define AGENT_MAX(a, b) ((a) > (b) ? (a) : (b))
#endif
#ifndef AGENT_MIN
#define AGENT_MIN(a, b) ((a) < (b) ? (a) : (b))
#endif

#define AGENT_UI_FLAG_DISABLED 1
#define AGENT_UI_FLAG_CHECKED 2
#define AGENT_UI_FLAG_DESTRUCTIVE 4
#define AGENT_UI_FLAG_PRIMARY 8
#define AGENT_UI_FLAG_STATUS 16
#define AGENT_UI_FLAG_REPLACE 32
#define AGENT_UI_FLAG_SELECTED 64

#define AGENT_UI_HEADER_HEIGHT 34
#define AGENT_UI_ACTION_BAR_WIDTH 38
#define AGENT_UI_SELECT_HOLD_MS 700
#define AGENT_UI_TOUCH_TAP_MAX 15
#define AGENT_UI_TOUCH_SWIPE_MIN 38

typedef enum {
  AgentUiElementUnknown = 0,
  AgentUiElementSection,
  AgentUiElementItem,
  AgentUiElementText,
  AgentUiElementMetric,
  AgentUiElementProgress,
  AgentUiElementField,
  AgentUiElementChoice,
  AgentUiElementAction,
  AgentUiElementBind,
  AgentUiElementImage,
  AgentUiElementSpacer,
  AgentUiElementHotspot,
} AgentUiElementKind;

typedef struct {
  bool used;
  AgentUiElementKind kind;
  char kind_name[AGENT_UI_KIND_LENGTH];
  char id[AGENT_UI_ID_LENGTH];
  char parent_id[AGENT_UI_ID_LENGTH];
  char title[AGENT_UI_TITLE_LENGTH];
  char subtitle[AGENT_UI_SUBTITLE_LENGTH];
  char value[AGENT_UI_VALUE_LENGTH];
  char action[AGENT_UI_ACTION_LENGTH];
  char meta[AGENT_UI_META_LENGTH];
  int32_t flags;
  int32_t index;
  GRect frame;
} AgentUiElement;

struct AgentUi {
  Window *window;
  ScrollLayer *scroll_layer;
  Layer *content_layer;
  Layer *action_bar_layer;
  StatusBarLayer *status_bar_layer;
  NumberWindow *number_window;
  AgentUiEventHandler event_handler;
  AgentUiDictationHandler dictation_handler;
  void *context;

  AgentUiLayout layout;
  char layout_name[AGENT_UI_KIND_LENGTH];
  char screen_id[AGENT_UI_ID_LENGTH];
  char title[AGENT_UI_TITLE_LENGTH];
  char subtitle[AGENT_UI_SUBTITLE_LENGTH];
  char meta[AGENT_UI_META_LENGTH];
  char status[AGENT_UI_SUBTITLE_LENGTH];
  int32_t screen_flags;
  AgentUiElement elements[AGENT_UI_MAX_ELEMENTS];
  uint8_t element_count;
  int16_t selected_element;
  int16_t editing_element;
  int32_t editing_min;
  int32_t editing_max;
  int32_t editing_step;
  int16_t content_height;
  int16_t viewport_width;
  int16_t viewport_height;
  bool loaded;
  bool complete;
  bool loading;
  bool error;
#if defined(PBL_TOUCH)
  bool touch_subscribed;
  bool touch_down;
  bool touch_dragged;
  int16_t touch_down_x;
  int16_t touch_down_y;
  int16_t touch_last_y;
#endif
};

static void prv_number_click_config_provider(void *context);

static AgentUiElementKind prv_element_kind(const char *kind) {
  if (!kind) { return AgentUiElementUnknown; }
  if (strcmp(kind, "section") == 0) { return AgentUiElementSection; }
  if (strcmp(kind, "item") == 0) { return AgentUiElementItem; }
  if (strcmp(kind, "text") == 0) { return AgentUiElementText; }
  if (strcmp(kind, "metric") == 0) { return AgentUiElementMetric; }
  if (strcmp(kind, "progress") == 0) { return AgentUiElementProgress; }
  if (strcmp(kind, "field") == 0) { return AgentUiElementField; }
  if (strcmp(kind, "choice") == 0) { return AgentUiElementChoice; }
  if (strcmp(kind, "action") == 0) { return AgentUiElementAction; }
  if (strcmp(kind, "bind") == 0) { return AgentUiElementBind; }
  if (strcmp(kind, "image") == 0) { return AgentUiElementImage; }
  if (strcmp(kind, "spacer") == 0) { return AgentUiElementSpacer; }
  if (strcmp(kind, "hotspot") == 0) { return AgentUiElementHotspot; }
  return AgentUiElementUnknown;
}

static AgentUiLayout prv_layout(const char *layout) {
  if (!layout) { return AgentUiLayoutText; }
  if (strcmp(layout, "list") == 0 || strcmp(layout, "menu") == 0) { return AgentUiLayoutList; }
  if (strcmp(layout, "grid") == 0) { return AgentUiLayoutGrid; }
  if (strcmp(layout, "card") == 0) { return AgentUiLayoutCard; }
  if (strcmp(layout, "progress") == 0) { return AgentUiLayoutProgress; }
  if (strcmp(layout, "form") == 0) { return AgentUiLayoutForm; }
  if (strcmp(layout, "choice") == 0) { return AgentUiLayoutChoice; }
  if (strcmp(layout, "modal") == 0) { return AgentUiLayoutModal; }
  return AgentUiLayoutText;
}

static bool prv_is_rendered(const AgentUiElement *element) {
  return element && element->used && element->kind != AgentUiElementBind &&
         element->kind != AgentUiElementHotspot && element->kind != AgentUiElementUnknown;
}

static bool prv_is_selectable(const AgentUiElement *element) {
  if (!element || !element->used || (element->flags & AGENT_UI_FLAG_DISABLED)) {
    return false;
  }
  return element->kind == AgentUiElementItem || element->kind == AgentUiElementAction ||
         element->kind == AgentUiElementField || element->kind == AgentUiElementChoice ||
         (element->kind == AgentUiElementMetric && element->action[0]);
}

static int prv_abs(int value) {
  return value < 0 ? -value : value;
}

static int16_t prv_horizontal_inset(void) {
#if defined(PBL_ROUND)
  return 24;
#else
  return 5;
#endif
}

static int16_t prv_header_inset(void) {
#if defined(PBL_ROUND)
  // The header sits near the top of the circle, where the usable width is
  // considerably narrower than it is for the rows below it.
  return 42;
#else
  return 7;
#endif
}

static int16_t prv_measure_text(const char *text, GFont font, int16_t width, int16_t minimum) {
  GSize size;
  if (!text || !text[0]) {
    return minimum;
  }
  size = graphics_text_layout_get_content_size(text, font, GRect(0, 0, width, 2000),
                                                GTextOverflowModeWordWrap, GTextAlignmentLeft);
  return AGENT_MAX(minimum, size.h + 2);
}

static AgentUiElement *prv_find_element(AgentUi *ui, const char *id) {
  uint8_t index;
  if (!ui || !id || !id[0]) {
    return NULL;
  }
  for (index = 0; index < ui->element_count; index += 1) {
    if (ui->elements[index].used && strcmp(ui->elements[index].id, id) == 0) {
      return &ui->elements[index];
    }
  }
  return NULL;
}

static int16_t prv_index_of(AgentUi *ui, AgentUiElement *element) {
  if (!ui || !element) {
    return -1;
  }
  return (int16_t)(element - ui->elements);
}

static AgentUiElement *prv_find_binding(AgentUi *ui, const char *input) {
  uint8_t index;
  char binding_input[24];
  for (index = 0; index < ui->element_count; index += 1) {
    AgentUiElement *element = &ui->elements[index];
    if (element->used && element->kind == AgentUiElementBind &&
        agent_protocol_meta_get(element->meta, "input", binding_input, sizeof(binding_input)) &&
        strcmp(binding_input, input) == 0) {
      return element;
    }
  }
  return NULL;
}

static bool prv_has_action_bar(AgentUi *ui) {
  return agent_protocol_meta_get_bool(ui->meta, "actionbar", false);
}

static void prv_emit(AgentUi *ui, const char *input, const AgentUiElement *element,
                     const char *action, const char *value) {
  AgentUiEvent event;
  if (!ui || !ui->event_handler || !action || !action[0]) {
    return;
  }
  memset(&event, 0, sizeof(event));
  agent_protocol_copy(event.input, sizeof(event.input), input);
  agent_protocol_copy(event.element_id, sizeof(event.element_id), element ? element->id : "");
  agent_protocol_copy(event.action, sizeof(event.action), action);
  agent_protocol_copy(event.value, sizeof(event.value), value ? value : (element ? element->value : ""));
  ui->event_handler(&event, ui->context);
}

static void prv_emit_binding(AgentUi *ui, const char *input, AgentUiElement *binding) {
  if (binding) {
    prv_emit(ui, input, binding, binding->action, binding->value);
  }
}

static int16_t prv_row_height(AgentUi *ui, AgentUiElement *element, int16_t width) {
  GFont body_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  int16_t content_width = AGENT_MAX(30, width - 12);
  switch (element->kind) {
    case AgentUiElementSection:
      return 25;
    case AgentUiElementText:
      return prv_measure_text(element->value[0] ? element->value : element->title,
                              body_font, content_width, 30) + 8;
    case AgentUiElementMetric:
      return ui->layout == AgentUiLayoutCard ? 52 : 43;
    case AgentUiElementProgress:
      return 55;
    case AgentUiElementField:
    case AgentUiElementChoice:
      return 50;
    case AgentUiElementAction:
      return 42;
    case AgentUiElementImage:
      return 58;
    case AgentUiElementSpacer:
      return (int16_t)AGENT_MAX(4, AGENT_MIN(100, agent_protocol_meta_get_int(element->meta, "height", 12)));
    case AgentUiElementItem:
      return element->subtitle[0] ? 52 : 42;
    default:
      return 0;
  }
}

static void prv_calculate_layout(AgentUi *ui) {
  int16_t inset;
  int16_t width;
  int16_t y;
  int16_t columns;
  int16_t column = 0;
  int16_t grid_y = 0;
  int16_t cell_width;
  int16_t cell_height = 58;
  uint8_t index;

  if (!ui || !ui->loaded || !ui->scroll_layer || !ui->content_layer) {
    return;
  }
  inset = prv_horizontal_inset();
  width = AGENT_MAX(40, ui->viewport_width - inset * 2);
  y = ui->title[0] ? AGENT_UI_HEADER_HEIGHT + 4 : 5;
#if defined(PBL_ROUND)
  // Keep a titleless first row below the narrow crown of a round display.
  if (!ui->title[0]) { y = 20; }
#endif
  columns = (int16_t)AGENT_MAX(1, AGENT_MIN(4, agent_protocol_meta_get_int(ui->meta, "columns", 2)));
  cell_width = width / columns;
  grid_y = y;

  for (index = 0; index < ui->element_count; index += 1) {
    AgentUiElement *element = &ui->elements[index];
    int16_t row_height;
    element->frame = GRectZero;
    if (!prv_is_rendered(element)) {
      continue;
    }
    if (ui->layout == AgentUiLayoutGrid &&
        (element->kind == AgentUiElementItem || element->kind == AgentUiElementChoice ||
         element->kind == AgentUiElementAction || element->kind == AgentUiElementMetric)) {
      element->frame = GRect(inset + column * cell_width, grid_y,
                             column == columns - 1 ? width - column * cell_width : cell_width,
                             cell_height);
      column += 1;
      if (column >= columns) {
        column = 0;
        grid_y += cell_height;
      }
      y = grid_y + (column ? cell_height : 0);
      continue;
    }
    if (ui->layout == AgentUiLayoutGrid && column) {
      column = 0;
      grid_y += cell_height;
      y = grid_y;
    }
    row_height = prv_row_height(ui, element, width);
    element->frame = GRect(inset, y, width, row_height);
    y += row_height;
    grid_y = y;
  }
  if (ui->layout == AgentUiLayoutGrid && column) {
    y = grid_y + cell_height;
  }
  if (ui->status[0]) {
    y += 28;
  }
  ui->content_height = AGENT_MAX(ui->viewport_height, y + 6);
  layer_set_frame(ui->content_layer, GRect(0, 0, ui->viewport_width, ui->content_height));
  scroll_layer_set_content_size(ui->scroll_layer, GSize(ui->viewport_width, ui->content_height));
}

static void prv_refresh(AgentUi *ui) {
  if (!ui || !ui->loaded) {
    return;
  }
  prv_calculate_layout(ui);
  layer_mark_dirty(ui->content_layer);
  if (ui->action_bar_layer) {
    layer_mark_dirty(ui->action_bar_layer);
  }
}

static void prv_draw_text(GContext *ctx, const char *text, GFont font, GRect frame,
                          GTextAlignment alignment, GColor color, GTextOverflowMode overflow) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text ? text : "", font, frame, overflow, alignment, NULL);
}

static void prv_draw_check(GContext *ctx, GPoint center, bool checked, GColor color) {
  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_fill_color(ctx, checked ? color : GColorClear);
  if (checked) {
    graphics_fill_circle(ctx, center, 7);
  } else {
    graphics_draw_circle(ctx, center, 7);
  }
}

static void prv_draw_symbol(GContext *ctx, const char *symbol, GRect frame, GColor color) {
  GPoint center = grect_center_point(&frame);
  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_fill_color(ctx, color);
  if (strcmp(symbol, "check") == 0) {
    graphics_context_set_stroke_width(ctx, 3);
    graphics_draw_line(ctx, GPoint(center.x - 10, center.y), GPoint(center.x - 3, center.y + 7));
    graphics_draw_line(ctx, GPoint(center.x - 3, center.y + 7), GPoint(center.x + 11, center.y - 8));
  } else if (strcmp(symbol, "up") == 0) {
    graphics_context_set_stroke_width(ctx, 3);
    graphics_draw_line(ctx, GPoint(center.x - 9, center.y + 5), GPoint(center.x, center.y - 5));
    graphics_draw_line(ctx, GPoint(center.x, center.y - 5), GPoint(center.x + 9, center.y + 5));
  } else if (strcmp(symbol, "down") == 0) {
    graphics_context_set_stroke_width(ctx, 3);
    graphics_draw_line(ctx, GPoint(center.x - 9, center.y - 5), GPoint(center.x, center.y + 5));
    graphics_draw_line(ctx, GPoint(center.x, center.y + 5), GPoint(center.x + 9, center.y - 5));
  } else if (strcmp(symbol, "left") == 0) {
    graphics_context_set_stroke_width(ctx, 3);
    graphics_draw_line(ctx, GPoint(center.x + 5, center.y - 9), GPoint(center.x - 5, center.y));
    graphics_draw_line(ctx, GPoint(center.x - 5, center.y), GPoint(center.x + 5, center.y + 9));
  } else if (strcmp(symbol, "right") == 0) {
    graphics_context_set_stroke_width(ctx, 3);
    graphics_draw_line(ctx, GPoint(center.x - 5, center.y - 9), GPoint(center.x + 5, center.y));
    graphics_draw_line(ctx, GPoint(center.x + 5, center.y), GPoint(center.x - 5, center.y + 9));
  } else if (strcmp(symbol, "warning") == 0) {
    GPathInfo path_info = {
      .num_points = 3,
      .points = (GPoint[]) { GPoint(center.x, center.y - 15), GPoint(center.x - 16, center.y + 13),
                             GPoint(center.x + 16, center.y + 13) }
    };
    GPath *path = gpath_create(&path_info);
    if (path) {
      gpath_draw_outline(ctx, path);
      gpath_destroy(path);
    }
    graphics_draw_line(ctx, GPoint(center.x, center.y - 7), GPoint(center.x, center.y + 5));
    graphics_fill_circle(ctx, GPoint(center.x, center.y + 9), 1);
  } else if (strcmp(symbol, "sun") == 0 || strcmp(symbol, "weather") == 0) {
    int angle;
    graphics_draw_circle(ctx, center, 10);
    for (angle = 0; angle < 360; angle += 45) {
      GPoint inner = gpoint_from_polar(GRect(center.x - 15, center.y - 15, 30, 30),
                                      GOvalScaleModeFitCircle, DEG_TO_TRIGANGLE(angle));
      GPoint outer = gpoint_from_polar(GRect(center.x - 20, center.y - 20, 40, 40),
                                      GOvalScaleModeFitCircle, DEG_TO_TRIGANGLE(angle));
      graphics_draw_line(ctx, inner, outer);
    }
  } else if (strcmp(symbol, "timer") == 0) {
    graphics_draw_circle(ctx, center, 15);
    graphics_draw_line(ctx, center, GPoint(center.x, center.y - 10));
    graphics_draw_line(ctx, center, GPoint(center.x + 8, center.y));
  } else {
    graphics_draw_circle(ctx, center, 15);
    prv_draw_text(ctx, "i", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                  GRect(center.x - 12, center.y - 16, 24, 32), GTextAlignmentCenter,
                  color, GTextOverflowModeTrailingEllipsis);
  }
}

static void prv_draw_element(AgentUi *ui, GContext *ctx, AgentUiElement *element, bool selected) {
  GRect frame = element->frame;
  GColor foreground = selected ? GColorWhite : GColorBlack;
  GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont body_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  GFont small_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  char display[AGENT_UI_VALUE_LENGTH + AGENT_UI_TITLE_LENGTH + 8];

  if (selected) {
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, frame, 4, GCornersAll);
  }

  switch (element->kind) {
    case AgentUiElementSection:
      prv_draw_text(ctx, element->title[0] ? element->title : element->value,
                    small_font, GRect(frame.origin.x + 4, frame.origin.y + 4,
                                      frame.size.w - 8, frame.size.h - 4),
                    GTextAlignmentLeft, GColorBlack, GTextOverflowModeTrailingEllipsis);
      graphics_context_set_stroke_color(ctx, GColorBlack);
      graphics_draw_line(ctx, GPoint(frame.origin.x, frame.origin.y + frame.size.h - 1),
                         GPoint(frame.origin.x + frame.size.w, frame.origin.y + frame.size.h - 1));
      break;
    case AgentUiElementItem:
    case AgentUiElementAction:
      prv_draw_text(ctx, element->title[0] ? element->title : element->value, title_font,
                    GRect(frame.origin.x + 5, frame.origin.y + (element->subtitle[0] ? 1 : 8),
                          frame.size.w - 10, 27), GTextAlignmentLeft, foreground,
                    GTextOverflowModeTrailingEllipsis);
      if (element->subtitle[0]) {
        prv_draw_text(ctx, element->subtitle, small_font,
                      GRect(frame.origin.x + 5, frame.origin.y + 25, frame.size.w - 10, 22),
                      GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      }
      break;
    case AgentUiElementText:
      prv_draw_text(ctx, element->value[0] ? element->value : element->title, body_font,
                    grect_inset(frame, GEdgeInsets(4)), GTextAlignmentLeft, foreground,
                    GTextOverflowModeWordWrap);
      break;
    case AgentUiElementMetric:
      prv_draw_text(ctx, element->title, small_font,
                    GRect(frame.origin.x + 4, frame.origin.y + 1, frame.size.w / 2, 20),
                    GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      prv_draw_text(ctx, element->value, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                    GRect(frame.origin.x + 4, frame.origin.y + 17, frame.size.w - 8, 32),
                    GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      break;
    case AgentUiElementProgress: {
      int32_t minimum = agent_protocol_meta_get_int(element->meta, "min", 0);
      int32_t maximum = agent_protocol_meta_get_int(element->meta, "max", 100);
      int32_t value = atoi(element->value);
      int16_t bar_width;
      GRect bar = GRect(frame.origin.x + 5, frame.origin.y + 29, frame.size.w - 10, 14);
      if (maximum <= minimum) { maximum = minimum + 1; }
      value = AGENT_MAX(minimum, AGENT_MIN(maximum, value));
      bar_width = (int16_t)(((int64_t)(value - minimum) * bar.size.w) / (maximum - minimum));
      snprintf(display, sizeof(display), "%s%s%s", element->title,
               element->title[0] && element->subtitle[0] ? "  " : "", element->subtitle);
      prv_draw_text(ctx, display, title_font,
                    GRect(frame.origin.x + 4, frame.origin.y, frame.size.w - 8, 27),
                    GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      graphics_context_set_stroke_color(ctx, foreground);
      graphics_draw_round_rect(ctx, bar, 4);
      graphics_context_set_fill_color(ctx, foreground);
      if (bar_width > 2) {
        graphics_fill_rect(ctx, GRect(bar.origin.x + 2, bar.origin.y + 2, bar_width - 2, bar.size.h - 4),
                           2, GCornersAll);
      }
      break;
    }
    case AgentUiElementField:
      prv_draw_text(ctx, element->title, title_font,
                    GRect(frame.origin.x + 5, frame.origin.y + 2, frame.size.w - 10, 25),
                    GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      prv_draw_text(ctx, element->value[0] ? element->value : element->subtitle, small_font,
                    GRect(frame.origin.x + 5, frame.origin.y + 27, frame.size.w - 10, 20),
                    GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      break;
    case AgentUiElementChoice:
      prv_draw_check(ctx, GPoint(frame.origin.x + 13, frame.origin.y + frame.size.h / 2),
                     (element->flags & AGENT_UI_FLAG_CHECKED) != 0, foreground);
      prv_draw_text(ctx, element->title[0] ? element->title : element->value, title_font,
                    GRect(frame.origin.x + 27, frame.origin.y + 8, frame.size.w - 31, 30),
                    GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      break;
    case AgentUiElementImage: {
      char symbol[24];
      if (!agent_protocol_meta_get(element->meta, "icon", symbol, sizeof(symbol))) {
        agent_protocol_copy(symbol, sizeof(symbol), element->value);
      }
      prv_draw_symbol(ctx, symbol, GRect(frame.origin.x + 4, frame.origin.y + 4, 50, frame.size.h - 8),
                      foreground);
      prv_draw_text(ctx, element->title, title_font,
                    GRect(frame.origin.x + 58, frame.origin.y + 12, frame.size.w - 62, 32),
                    GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      break;
    }
    default:
      break;
  }
}

static void prv_content_update_proc(Layer *layer, GContext *ctx) {
  AgentUi **slot = layer_get_data(layer);
  AgentUi *ui = slot ? *slot : NULL;
  uint8_t index;
  if (!ui) {
    return;
  }
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, layer_get_bounds(layer), 0, GCornerNone);

  if (ui->title[0]) {
    int16_t header_inset = prv_header_inset();
    prv_draw_text(ctx, ui->title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                  GRect(header_inset, 1, ui->viewport_width - header_inset * 2, 31),
                  GTextAlignmentLeft, GColorBlack, GTextOverflowModeTrailingEllipsis);
    if (!ui->complete || ui->loading) {
      prv_draw_text(ctx, "...", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                    GRect(ui->viewport_width - header_inset - 28, 5, 26, 22),
                    GTextAlignmentRight, GColorBlack, GTextOverflowModeTrailingEllipsis);
    }
  }

  for (index = 0; index < ui->element_count; index += 1) {
    AgentUiElement *element = &ui->elements[index];
    if (prv_is_rendered(element)) {
      prv_draw_element(ui, ctx, element, ui->selected_element == index && prv_is_selectable(element));
    }
  }
  if (ui->status[0]) {
    GPoint offset = scroll_layer_get_content_offset(ui->scroll_layer);
    int16_t visible_bottom = (int16_t)(-offset.y + ui->viewport_height);
    int16_t status_y = AGENT_MIN(ui->content_height - 27, visible_bottom - 27);
    GRect status_frame = GRect(prv_horizontal_inset(), AGENT_MAX(0, status_y),
                               ui->viewport_width - prv_horizontal_inset() * 2, 24);
    graphics_context_set_fill_color(ctx, ui->error ? GColorBlack : GColorLightGray);
    graphics_fill_rect(ctx, status_frame, 3, GCornersAll);
    prv_draw_text(ctx, ui->status, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                  grect_inset(status_frame, GEdgeInsets(2, 4)), GTextAlignmentCenter,
                  ui->error ? GColorWhite : GColorBlack, GTextOverflowModeTrailingEllipsis);
  }
}

static void prv_draw_action_icon(GContext *ctx, GRect frame, const char *input, const char *icon) {
  GPoint center = grect_center_point(&frame);
  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_context_set_stroke_width(ctx, 2);
  if (icon && icon[0]) {
    prv_draw_symbol(ctx, icon, frame, GColorWhite);
  } else if (strcmp(input, "up") == 0) {
    graphics_draw_line(ctx, GPoint(center.x - 7, center.y + 4), GPoint(center.x, center.y - 4));
    graphics_draw_line(ctx, GPoint(center.x, center.y - 4), GPoint(center.x + 7, center.y + 4));
  } else if (strcmp(input, "down") == 0) {
    graphics_draw_line(ctx, GPoint(center.x - 7, center.y - 4), GPoint(center.x, center.y + 4));
    graphics_draw_line(ctx, GPoint(center.x, center.y + 4), GPoint(center.x + 7, center.y - 4));
  } else {
    graphics_draw_circle(ctx, center, 6);
  }
}

static void prv_action_bar_update_proc(Layer *layer, GContext *ctx) {
  AgentUi **slot = layer_get_data(layer);
  AgentUi *ui = slot ? *slot : NULL;
  const char *inputs[3] = { "up", "select", "down" };
  int index;
  GRect bounds = layer_get_bounds(layer);
  if (!ui) { return; }
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  for (index = 0; index < 3; index += 1) {
    AgentUiElement *binding = prv_find_binding(ui, inputs[index]);
    GRect frame = GRect(0, index * bounds.size.h / 3, bounds.size.w,
                        (index + 1) * bounds.size.h / 3 - index * bounds.size.h / 3);
    char icon[24] = "";
    if (binding) {
      agent_protocol_meta_get(binding->meta, "icon", icon, sizeof(icon));
      prv_draw_action_icon(ctx, frame, inputs[index], icon);
    }
  }
}

static void prv_relayout_root(AgentUi *ui) {
  Layer *root;
  GRect bounds;
  int16_t top;
  int16_t action_width;
  int16_t action_top;
  int16_t action_height;
  bool status_visible;
  bool action_visible;
  if (!ui || !ui->loaded) { return; }
  root = window_get_root_layer(ui->window);
  bounds = layer_get_bounds(root);
  status_visible = (ui->screen_flags & AGENT_UI_FLAG_STATUS) != 0;
  action_visible = prv_has_action_bar(ui);
  top = status_visible ? STATUS_BAR_LAYER_HEIGHT : 0;
#if defined(PBL_ROUND)
  // A hidden status bar still needs equivalent breathing room so custom
  // content does not begin in the clipped crown of the circle.
  if (!status_visible) { top = STATUS_BAR_LAYER_HEIGHT; }
#endif
  action_width = action_visible ? AGENT_UI_ACTION_BAR_WIDTH : 0;
  action_top = top;
  action_height = bounds.size.h - top;
#if defined(PBL_ROUND)
  if (action_visible) {
    action_top = AGENT_MAX(top, 32);
    action_height = AGENT_MAX(60, bounds.size.h - action_top - 32);
  }
#endif
  layer_set_hidden(status_bar_layer_get_layer(ui->status_bar_layer), !status_visible);
  layer_set_hidden(ui->action_bar_layer, !action_visible);
  layer_set_frame(ui->action_bar_layer,
                  GRect(bounds.size.w - action_width, action_top, action_width, action_height));
  layer_set_frame(scroll_layer_get_layer(ui->scroll_layer),
                  GRect(0, top, bounds.size.w - action_width, bounds.size.h - top));
  ui->viewport_width = bounds.size.w - action_width;
  ui->viewport_height = bounds.size.h - top;
  prv_refresh(ui);
}

static void prv_ensure_visible(AgentUi *ui, bool animated) {
  AgentUiElement *element;
  GPoint offset;
  int16_t visible_top;
  int16_t visible_bottom;
  int16_t next_y;
  if (!ui || !ui->scroll_layer || ui->selected_element < 0 ||
      ui->selected_element >= ui->element_count) {
    return;
  }
  element = &ui->elements[ui->selected_element];
  offset = scroll_layer_get_content_offset(ui->scroll_layer);
  visible_top = -offset.y;
  visible_bottom = visible_top + ui->viewport_height;
  next_y = offset.y;
  if (element->frame.origin.y < visible_top) {
    next_y = -element->frame.origin.y;
  } else if (element->frame.origin.y + element->frame.size.h > visible_bottom) {
    next_y = -(element->frame.origin.y + element->frame.size.h - ui->viewport_height);
  }
  next_y = AGENT_MIN(0, AGENT_MAX(-(ui->content_height - ui->viewport_height), next_y));
  scroll_layer_set_content_offset(ui->scroll_layer, GPoint(0, next_y), animated);
}

static void prv_scroll(AgentUi *ui, int delta, bool animated) {
  GPoint offset;
  int16_t next_y;
  if (!ui || !ui->scroll_layer) { return; }
  offset = scroll_layer_get_content_offset(ui->scroll_layer);
  next_y = offset.y + delta;
  next_y = AGENT_MIN(0, AGENT_MAX(-(ui->content_height - ui->viewport_height), next_y));
  scroll_layer_set_content_offset(ui->scroll_layer, GPoint(0, next_y), animated);
}

static void prv_move_selection(AgentUi *ui, int direction) {
  int16_t index;
  int16_t step = direction;
  int16_t columns;
  if (!ui) { return; }
  if (ui->layout == AgentUiLayoutGrid) {
    columns = (int16_t)AGENT_MAX(1, AGENT_MIN(4, agent_protocol_meta_get_int(ui->meta, "columns", 2)));
    step = direction * columns;
  }
  index = ui->selected_element;
  if (index < 0) {
    index = direction > 0 ? -1 : ui->element_count;
    step = direction;
  }
  index += step;
  while (index >= 0 && index < ui->element_count && !prv_is_selectable(&ui->elements[index])) {
    index += direction > 0 ? 1 : -1;
  }
  if (index < 0 || index >= ui->element_count) {
    if (ui->selected_element < 0) {
      prv_scroll(ui, direction > 0 ? -42 : 42, true);
    }
    return;
  }
  ui->selected_element = index;
  layer_mark_dirty(ui->content_layer);
  prv_ensure_visible(ui, true);
}

static void prv_number_selected(NumberWindow *number_window, void *context) {
  AgentUi *ui = context;
  AgentUiElement *element;
  int32_t value;
  if (!ui || ui->editing_element < 0 || ui->editing_element >= ui->element_count) {
    return;
  }
  element = &ui->elements[ui->editing_element];
  value = number_window_get_value(number_window);
  snprintf(element->value, sizeof(element->value), "%ld", (long)value);
  prv_refresh(ui);
  prv_emit(ui, "field", element, element->action, element->value);
  window_stack_pop(true);
  ui->editing_element = -1;
}

static void prv_open_number(AgentUi *ui, AgentUiElement *element) {
  int32_t minimum;
  int32_t maximum;
  int32_t step;
  int32_t value;
  if (!ui || !element) { return; }
  if (ui->number_window) {
    number_window_destroy(ui->number_window);
    ui->number_window = NULL;
  }
  ui->editing_element = prv_index_of(ui, element);
  ui->number_window = number_window_create(element->title[0] ? element->title : "Value",
                                            (NumberWindowCallbacks) {
                                              .selected = prv_number_selected,
                                            }, ui);
  if (!ui->number_window) {
    ui->editing_element = -1;
    return;
  }
  minimum = agent_protocol_meta_get_int(element->meta, "min", 0);
  maximum = agent_protocol_meta_get_int(element->meta, "max", 100);
  step = AGENT_MAX(1, agent_protocol_meta_get_int(element->meta, "step", 1));
  value = atoi(element->value);
  number_window_set_min(ui->number_window, minimum);
  number_window_set_max(ui->number_window, AGENT_MAX(minimum, maximum));
  number_window_set_step_size(ui->number_window, step);
  number_window_set_value(ui->number_window, AGENT_MAX(minimum, AGENT_MIN(maximum, value)));
  ui->editing_min = minimum;
  ui->editing_max = AGENT_MAX(minimum, maximum);
  ui->editing_step = step;
  window_set_click_config_provider_with_context(number_window_get_window(ui->number_window),
                                                 prv_number_click_config_provider, ui);
  window_stack_push(number_window_get_window(ui->number_window), true);
}

static void prv_activate_element(AgentUi *ui, AgentUiElement *element, const char *input) {
  char field_type[20];
  if (!ui || !element || !prv_is_selectable(element)) { return; }
  ui->selected_element = prv_index_of(ui, element);
  layer_mark_dirty(ui->content_layer);
  if (element->kind == AgentUiElementField &&
      agent_protocol_meta_get(element->meta, "type", field_type, sizeof(field_type)) &&
      strcmp(field_type, "number") == 0) {
    prv_open_number(ui, element);
    return;
  }
  prv_emit(ui, input, element, element->action, element->value);
}

static void prv_handle_input(AgentUi *ui, const char *input) {
  AgentUiElement *binding = prv_find_binding(ui, input);
  if (binding) {
    prv_emit_binding(ui, input, binding);
    return;
  }
  if (strcmp(input, "up") == 0) {
    if (ui->selected_element >= 0) { prv_move_selection(ui, -1); }
    else { prv_scroll(ui, 42, true); }
  } else if (strcmp(input, "down") == 0) {
    if (ui->selected_element >= 0) { prv_move_selection(ui, 1); }
    else { prv_scroll(ui, -42, true); }
  } else if (strcmp(input, "select") == 0 && ui->selected_element >= 0) {
    prv_activate_element(ui, &ui->elements[ui->selected_element], input);
  }
}

static void prv_up_click(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  prv_handle_input(context, "up");
}

static void prv_down_click(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  prv_handle_input(context, "down");
}

static void prv_back_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  AgentUiElement *binding;
  (void)recognizer;
  binding = prv_find_binding(ui, "back");
  if (binding) {
    prv_emit_binding(ui, "back", binding);
  } else {
    window_stack_pop(true);
  }
}

static void prv_select_long_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  (void)recognizer;
  if (ui->dictation_handler) {
    ui->dictation_handler(ui->context);
  }
}

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  prv_handle_input(context, "select");
}

static void prv_number_up_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  int32_t value;
  (void)recognizer;
  if (!ui || !ui->number_window) { return; }
  value = number_window_get_value(ui->number_window);
  number_window_set_value(ui->number_window,
                          AGENT_MIN(ui->editing_max, value + ui->editing_step));
}

static void prv_number_down_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  int32_t value;
  (void)recognizer;
  if (!ui || !ui->number_window) { return; }
  value = number_window_get_value(ui->number_window);
  number_window_set_value(ui->number_window,
                          AGENT_MAX(ui->editing_min, value - ui->editing_step));
}

static void prv_number_back_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  (void)recognizer;
  ui->editing_element = -1;
  window_stack_pop(true);
}

static void prv_number_select_long_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  (void)recognizer;
  ui->editing_element = -1;
  window_stack_pop(false);
  if (ui->dictation_handler) {
    ui->dictation_handler(ui->context);
  }
}

static void prv_number_select_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  (void)recognizer;
  if (ui->number_window) {
    prv_number_selected(ui->number_window, ui);
  }
}

static void prv_number_click_config_provider(void *context) {
  (void)context;
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 180, prv_number_up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 180, prv_number_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_number_select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, AGENT_UI_SELECT_HOLD_MS,
                              prv_number_select_long_click, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, prv_number_back_click);
}

static void prv_click_config_provider(void *context) {
  (void)context;
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 180, prv_up_click);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 180, prv_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, AGENT_UI_SELECT_HOLD_MS,
                              prv_select_long_click, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, prv_back_click);
}

#if defined(PBL_TOUCH)
static AgentUiElement *prv_hit_test(AgentUi *ui, int16_t x, int16_t y) {
  GRect scroll_frame;
  GPoint offset;
  GPoint point;
  uint8_t index;
  if (!ui || !ui->scroll_layer) { return NULL; }
  scroll_frame = layer_get_frame(scroll_layer_get_layer(ui->scroll_layer));
  offset = scroll_layer_get_content_offset(ui->scroll_layer);
  point = GPoint(x - scroll_frame.origin.x, y - scroll_frame.origin.y - offset.y);
  for (index = 0; index < ui->element_count; index += 1) {
    AgentUiElement *element = &ui->elements[index];
    if (prv_is_selectable(element) && grect_contains_point(&element->frame, &point)) {
      return element;
    }
  }
  return NULL;
}

static AgentUiElement *prv_hotspot(AgentUi *ui, int16_t x, int16_t y) {
  Layer *root = window_get_root_layer(ui->window);
  GRect bounds = layer_get_bounds(root);
  uint8_t index;
  for (index = 0; index < ui->element_count; index += 1) {
    AgentUiElement *element = &ui->elements[index];
    int32_t left;
    int32_t top;
    int32_t width;
    int32_t height;
    GRect frame;
    GPoint point = GPoint(x, y);
    if (!element->used || element->kind != AgentUiElementHotspot) { continue; }
    left = agent_protocol_meta_get_int(element->meta, "x", 0);
    top = agent_protocol_meta_get_int(element->meta, "y", 0);
    width = agent_protocol_meta_get_int(element->meta, "width", 100);
    height = agent_protocol_meta_get_int(element->meta, "height", 100);
    frame = GRect(bounds.size.w * left / 100, bounds.size.h * top / 100,
                  bounds.size.w * width / 100, bounds.size.h * height / 100);
    if (grect_contains_point(&frame, &point)) { return element; }
  }
  return NULL;
}

static void prv_touch_handler(const TouchEvent *event, void *context) {
  AgentUi *ui = context;
  int dx;
  int dy;
  if (!ui || !event) { return; }
  switch (event->type) {
    case TouchEvent_Touchdown:
      ui->touch_down = true;
      ui->touch_dragged = false;
      ui->touch_down_x = event->x;
      ui->touch_down_y = event->y;
      ui->touch_last_y = event->y;
      break;
    case TouchEvent_PositionUpdate:
      if (!ui->touch_down) { break; }
      if (prv_abs(event->x - ui->touch_down_x) > AGENT_UI_TOUCH_TAP_MAX ||
          prv_abs(event->y - ui->touch_down_y) > AGENT_UI_TOUCH_TAP_MAX) {
        ui->touch_dragged = true;
      }
      dy = event->y - ui->touch_last_y;
      if (dy) { prv_scroll(ui, dy, false); }
      ui->touch_last_y = event->y;
      break;
    case TouchEvent_Liftoff:
      if (!ui->touch_down) { break; }
      ui->touch_down = false;
      dx = event->x - ui->touch_down_x;
      dy = event->y - ui->touch_down_y;
      if (prv_abs(dx) > AGENT_UI_TOUCH_SWIPE_MIN && prv_abs(dx) > prv_abs(dy)) {
        const char *gesture = dx > 0 ? "swipe-right" : "swipe-left";
        AgentUiElement *binding = prv_find_binding(ui, gesture);
        if (binding) { prv_emit_binding(ui, gesture, binding); }
        else if (dx > 0) { window_stack_pop(true); }
      } else if (prv_abs(dy) > AGENT_UI_TOUCH_SWIPE_MIN && prv_abs(dy) > prv_abs(dx)) {
        const char *gesture = dy > 0 ? "swipe-down" : "swipe-up";
        AgentUiElement *binding = prv_find_binding(ui, gesture);
        if (binding) { prv_emit_binding(ui, gesture, binding); }
      } else if (!ui->touch_dragged) {
        GRect action_frame = layer_get_frame(ui->action_bar_layer);
        AgentUiElement *element;
        if (prv_has_action_bar(ui) && ui->touch_down_x >= action_frame.origin.x) {
          int section = (ui->touch_down_y - action_frame.origin.y) * 3 / AGENT_MAX(1, action_frame.size.h);
          const char *input = section <= 0 ? "up" : (section == 1 ? "select" : "down");
          AgentUiElement *binding = prv_find_binding(ui, input);
          if (binding) { prv_emit_binding(ui, input, binding); }
          break;
        }
        element = prv_hotspot(ui, ui->touch_down_x, ui->touch_down_y);
        if (!element) { element = prv_hit_test(ui, ui->touch_down_x, ui->touch_down_y); }
        if (element && element->kind == AgentUiElementHotspot) {
          prv_emit(ui, "tap", element, element->action, element->value);
        } else if (element) { prv_activate_element(ui, element, "tap"); }
        else {
          AgentUiElement *binding = prv_find_binding(ui, "tap");
          if (binding) { prv_emit_binding(ui, "tap", binding); }
        }
      }
      break;
  }
}
#endif

static void prv_window_load(Window *window) {
  AgentUi *ui = window_get_user_data(window);
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  AgentUi **slot;
  ui->status_bar_layer = status_bar_layer_create();
  status_bar_layer_set_colors(ui->status_bar_layer, GColorWhite, GColorBlack);
  status_bar_layer_set_separator_mode(ui->status_bar_layer, StatusBarLayerSeparatorModeDotted);
  layer_add_child(root, status_bar_layer_get_layer(ui->status_bar_layer));

  ui->scroll_layer = scroll_layer_create(bounds);
  layer_add_child(root, scroll_layer_get_layer(ui->scroll_layer));
  ui->content_layer = layer_create_with_data(bounds, sizeof(AgentUi *));
  slot = layer_get_data(ui->content_layer);
  *slot = ui;
  layer_set_update_proc(ui->content_layer, prv_content_update_proc);
  scroll_layer_add_child(ui->scroll_layer, ui->content_layer);

  ui->action_bar_layer = layer_create_with_data(GRect(bounds.size.w, 0, 0, bounds.size.h),
                                                 sizeof(AgentUi *));
  slot = layer_get_data(ui->action_bar_layer);
  *slot = ui;
  layer_set_update_proc(ui->action_bar_layer, prv_action_bar_update_proc);
  layer_add_child(root, ui->action_bar_layer);

  ui->loaded = true;
  prv_relayout_root(ui);
}

static void prv_window_unload(Window *window) {
  AgentUi *ui = window_get_user_data(window);
  ui->loaded = false;
  if (ui->action_bar_layer) { layer_destroy(ui->action_bar_layer); ui->action_bar_layer = NULL; }
  if (ui->content_layer) { layer_destroy(ui->content_layer); ui->content_layer = NULL; }
  if (ui->scroll_layer) { scroll_layer_destroy(ui->scroll_layer); ui->scroll_layer = NULL; }
  if (ui->status_bar_layer) { status_bar_layer_destroy(ui->status_bar_layer); ui->status_bar_layer = NULL; }
}

static void prv_window_appear(Window *window) {
  AgentUi *ui = window_get_user_data(window);
#if defined(PBL_TOUCH)
  if (!ui->touch_subscribed && touch_service_is_enabled()) {
    touch_service_subscribe(prv_touch_handler, ui);
    ui->touch_subscribed = true;
  }
#else
  (void)ui;
#endif
}

static void prv_window_disappear(Window *window) {
  AgentUi *ui = window_get_user_data(window);
#if defined(PBL_TOUCH)
  if (ui->touch_subscribed) {
    touch_service_unsubscribe();
    ui->touch_subscribed = false;
  }
#else
  (void)ui;
#endif
}

AgentUi *agent_ui_create(AgentUiEventHandler event_handler, AgentUiDictationHandler dictation_handler,
                         void *context) {
  AgentUi *ui = calloc(1, sizeof(AgentUi));
  if (!ui) { return NULL; }
  ui->event_handler = event_handler;
  ui->dictation_handler = dictation_handler;
  ui->context = context;
  ui->selected_element = -1;
  ui->editing_element = -1;
  ui->window = window_create();
  if (!ui->window) {
    free(ui);
    return NULL;
  }
  window_set_background_color(ui->window, GColorWhite);
  window_set_user_data(ui->window, ui);
  window_set_window_handlers(ui->window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
    .appear = prv_window_appear,
    .disappear = prv_window_disappear,
  });
  window_set_click_config_provider_with_context(ui->window, prv_click_config_provider, ui);
  agent_protocol_copy(ui->layout_name, sizeof(ui->layout_name), "text");
  return ui;
}

void agent_ui_destroy(AgentUi *ui) {
  if (!ui) { return; }
#if defined(PBL_TOUCH)
  if (ui->touch_subscribed) { touch_service_unsubscribe(); }
#endif
  if (ui->number_window) { number_window_destroy(ui->number_window); }
  if (ui->window) { window_destroy(ui->window); }
  free(ui);
}

Window *agent_ui_get_window(AgentUi *ui) {
  return ui ? ui->window : NULL;
}

void agent_ui_show(AgentUi *ui, bool animated) {
  if (ui && ui->window && window_stack_get_top_window() != ui->window) {
    window_stack_push(ui->window, animated);
  }
}

void agent_ui_begin(AgentUi *ui, const char *screen_id, const char *layout, const char *title,
                    const char *subtitle, const char *meta, int32_t flags) {
  if (!ui) { return; }
  memset(ui->elements, 0, sizeof(ui->elements));
  ui->element_count = 0;
  ui->selected_element = -1;
  ui->complete = false;
  ui->loading = true;
  ui->error = false;
  ui->status[0] = '\0';
  ui->screen_flags = flags;
  ui->layout = prv_layout(layout);
  agent_protocol_copy(ui->screen_id, sizeof(ui->screen_id), screen_id);
  agent_protocol_copy(ui->layout_name, sizeof(ui->layout_name), layout);
  agent_protocol_copy(ui->title, sizeof(ui->title), title);
  agent_protocol_copy(ui->subtitle, sizeof(ui->subtitle), subtitle);
  agent_protocol_copy(ui->meta, sizeof(ui->meta), meta);
  if (ui->loaded) {
    scroll_layer_set_content_offset(ui->scroll_layer, GPointZero, false);
    prv_relayout_root(ui);
  }
}

static void prv_apply_spec(AgentUiElement *element, const AgentUiElementSpec *spec, bool patch) {
  uint32_t present = patch ? spec->present : AgentUiPresentAll;
  if (present & AgentUiPresentKind) {
    element->kind = prv_element_kind(spec->kind);
    agent_protocol_copy(element->kind_name, sizeof(element->kind_name), spec->kind);
  }
  if (present & AgentUiPresentId) { agent_protocol_copy(element->id, sizeof(element->id), spec->id); }
  if (present & AgentUiPresentParentId) {
    agent_protocol_copy(element->parent_id, sizeof(element->parent_id), spec->parent_id);
  }
  if (present & AgentUiPresentTitle) { agent_protocol_copy(element->title, sizeof(element->title), spec->title); }
  if (present & AgentUiPresentSubtitle) {
    agent_protocol_copy(element->subtitle, sizeof(element->subtitle), spec->subtitle);
  }
  if (present & AgentUiPresentValue) { agent_protocol_copy(element->value, sizeof(element->value), spec->value); }
  if (present & AgentUiPresentAction) {
    agent_protocol_copy(element->action, sizeof(element->action), spec->action);
  }
  if (present & AgentUiPresentMeta) { agent_protocol_copy(element->meta, sizeof(element->meta), spec->meta); }
  if (present & AgentUiPresentFlags) { element->flags = spec->flags; }
  if (present & AgentUiPresentIndex) { element->index = spec->index; }
}

bool agent_ui_add(AgentUi *ui, const AgentUiElementSpec *spec) {
  AgentUiElement *element;
  if (!ui || !spec || !spec->id || !spec->id[0] || ui->element_count >= AGENT_UI_MAX_ELEMENTS ||
      prv_find_element(ui, spec->id)) {
    return false;
  }
  element = &ui->elements[ui->element_count];
  memset(element, 0, sizeof(*element));
  element->used = true;
  prv_apply_spec(element, spec, false);
  if (prv_is_selectable(element) && ui->selected_element < 0) {
    ui->selected_element = ui->element_count;
  }
  ui->element_count += 1;
  prv_refresh(ui);
  return true;
}

bool agent_ui_patch(AgentUi *ui, const AgentUiElementSpec *spec) {
  AgentUiElement *element;
  if (!ui || !spec) { return false; }
  element = prv_find_element(ui, spec->id);
  if (!element) { return false; }
  prv_apply_spec(element, spec, true);
  prv_refresh(ui);
  return true;
}

bool agent_ui_append(AgentUi *ui, const char *element_id, const char *value) {
  AgentUiElement *element = prv_find_element(ui, element_id);
  size_t available;
  if (!element || !value) { return false; }
  available = sizeof(element->value) - strlen(element->value) - 1;
  if (available) {
    strncat(element->value, value, available);
  }
  prv_refresh(ui);
  return true;
}

bool agent_ui_remove(AgentUi *ui, const char *element_id) {
  AgentUiElement *element = prv_find_element(ui, element_id);
  int16_t index;
  if (!element) { return false; }
  index = prv_index_of(ui, element);
  if (index + 1 < ui->element_count) {
    memmove(&ui->elements[index], &ui->elements[index + 1],
            (ui->element_count - index - 1) * sizeof(AgentUiElement));
  }
  ui->element_count -= 1;
  memset(&ui->elements[ui->element_count], 0, sizeof(AgentUiElement));
  if (ui->selected_element == index) { ui->selected_element = -1; }
  else if (ui->selected_element > index) { ui->selected_element -= 1; }
  if (ui->selected_element < 0) {
    for (index = 0; index < ui->element_count; index += 1) {
      if (prv_is_selectable(&ui->elements[index])) { ui->selected_element = index; break; }
    }
  }
  prv_refresh(ui);
  return true;
}

void agent_ui_end(AgentUi *ui) {
  if (!ui) { return; }
  ui->complete = true;
  ui->loading = false;
  prv_refresh(ui);
}

void agent_ui_set_status(AgentUi *ui, const char *status, bool is_error, bool loading) {
  if (!ui) { return; }
  agent_protocol_copy(ui->status, sizeof(ui->status), status);
  ui->error = is_error;
  ui->loading = loading;
  prv_refresh(ui);
}

const char *agent_ui_screen_id(const AgentUi *ui) {
  return ui ? ui->screen_id : "";
}

const char *agent_ui_layout_name(const AgentUi *ui) {
  return ui ? ui->layout_name : "";
}
