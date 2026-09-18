#include "agent_ui.h"
#include "agent_ui_element.h"
#include "range_control.h"
#include "gesture_controller.h"
#include "ripple.h"
#include "refresh_policy.h"
#include "ui_invalidation.h"
#include "timeline_ui.h"
#include "artwork_cache.h"

#include "agent_protocol.h"
#include "dashboard_renderer.h"

#include <stdlib.h>
#include <string.h>
#include <limits.h>

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

struct AgentUi {
  uint32_t error_revision;
  Window *window;
  ScrollLayer *scroll_layer;
  Layer *content_layer;
  Layer *action_bar_layer;
  Layer *menu_layer;
  AppTimer *activity_timer;
  uint8_t request_frame, spinner_frame;
  AppTimer *menu_timer;
  uint8_t menu_count, menu_selected, menu_step;
  struct { char title[48]; char action[AGENT_UI_ACTION_LENGTH]; } menu_items[4];
  Layer *status_bar_layer;
  int codex_remaining, codex_active;
  char codex_state[12];
  RefreshPolicy refresh_policy;
  AppTimer *refresh_timer;
  uint32_t input_until;
  uint8_t dirty;
  bool root_dirty, input_active, visible;
  NumberWindow *number_window;
  GBitmap *dashboard_icons[DashboardIconCount];
  ArtworkCache artwork;
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
  bool tap_animation;
  bool double_tap;
  GestureController gesture;
  Layer *ripple_layer;
  AppTimer *ripple_timer;
  GPoint ripple_origin;
  uint8_t ripple_frame;
  AppTimer *hold_timer;
  bool touch_consumed;
  int16_t touch_last_x;
  bool touch_horizontal;
  bool touch_was_menu;
  bool touch_row;
  bool touch_vertical;
  int16_t touch_control;
  int32_t touch_angle;
  int64_t touch_raw_value;
  bool touch_subscribed;
  bool touch_down;
  bool touch_dragged;
  int16_t touch_down_x;
  int16_t touch_down_y;
  int16_t touch_last_y;
#endif
};

static void prv_stop_activity(AgentUi *ui) {
  if (ui->activity_timer) { app_timer_cancel(ui->activity_timer); ui->activity_timer=NULL; }
  ui->request_frame=0;
  artwork_cache_clear(&ui->artwork);
}

#if defined(PBL_TOUCH)
static void prv_stop_ripple(AgentUi *ui) {
  if (ui->ripple_timer) { app_timer_cancel(ui->ripple_timer); ui->ripple_timer = NULL; }
  ui->ripple_frame = 0;
  if (ui->ripple_layer) layer_set_hidden(ui->ripple_layer, true);
}
#endif
static void prv_reset_touch_guard(AgentUi *ui) {
#if defined(PBL_TOUCH)
  prv_stop_ripple(ui);
  gesture_controller_reset(&ui->gesture);
  ui->touch_down = false;
  if (ui->hold_timer) { app_timer_cancel(ui->hold_timer); ui->hold_timer = NULL; }
#else
  (void)ui;
#endif
}


static void prv_number_click_config_provider(void *context);
static void prv_dismiss_menu(AgentUi *ui);

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
  agent_protocol_copy(event.meta, sizeof(event.meta), element ? element->meta : "");
  ui->event_handler(&event, ui->context);
}

static void prv_input(AgentUi *ui) {
  agent_ui_note_input(ui);
  prv_emit(ui,"activity",NULL,"local.activity","");
  agent_ui_note_input(ui);
}

static void prv_emit_binding(AgentUi *ui, const char *input, AgentUiElement *binding) {
  if (binding) {
    prv_emit(ui, input, binding, binding->action, binding->value);
  }
}

static bool prv_todo_row(const AgentUiElement *element) {
  return element && element->kind == AgentUiElementChoice &&
         agent_protocol_meta_get_bool(element->meta, "todo", false);
}
static bool prv_todo_screen(AgentUi *ui) {
  return strcmp(ui->screen_id, "todos") == 0 || strcmp(ui->screen_id, "todo-archive") == 0;
}
static void prv_pan_todo(AgentUi *ui, AgentUiElement *e, int direction) {
  if (!prv_todo_row(e)) { return; }
  size_t length = strlen(e->value);
  for (int step = 0; step < 4; ++step) {
    if (direction > 0 && (size_t)e->text_offset + 1 < length) {
      ++e->text_offset;
      while (e->text_offset < length && ((unsigned char)e->value[e->text_offset] & 0xc0) == 0x80) { ++e->text_offset; }
      if (e->text_offset == length) { --e->text_offset; while (e->text_offset && ((unsigned char)e->value[e->text_offset] & 0xc0) == 0x80) { --e->text_offset; } }
    } else if (direction < 0 && e->text_offset) {
      --e->text_offset;
      while (e->text_offset && ((unsigned char)e->value[e->text_offset] & 0xc0) == 0x80) { --e->text_offset; }
    }
  }
  layer_mark_dirty(ui->content_layer);
}

static int prv_control_kind(const AgentUiElement *e) {
  char type[20];
  if (!e || e->kind != AgentUiElementField) { return 0; }
  agent_protocol_meta_get(e->meta, "type", type, sizeof(type));
  return strcmp(type, "slider") == 0 ? 1 : strcmp(type, "dial") == 0 ? 2 : 0;
}

static int16_t prv_row_height(AgentUi *ui, AgentUiElement *element, int16_t width) {
  if (prv_todo_row(element)) { return 42; }
  if (prv_control_kind(element)) { return prv_control_kind(element) == 1 ? 104 : 152; }
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

static GRect prv_dashboard_frame(AgentUi *ui, const char *id) {
 return dashboard_frame(ui->viewport_width,ui->viewport_height,id);
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
  if (strcmp(ui->screen_id, "dashboard") == 0) {
    for (index = 0; index < ui->element_count; ++index) {
      AgentUiElement *e = &ui->elements[index];
      e->frame = prv_dashboard_frame(ui, e->id);
      if (!e->frame.size.h) { e->flags |= AGENT_UI_FLAG_DISABLED; }
    }
    ui->content_height = ui->viewport_height;
    layer_set_frame(ui->content_layer, GRect(0, 0, ui->viewport_width, ui->content_height));
    scroll_layer_set_content_size(ui->scroll_layer, GSize(ui->viewport_width, ui->content_height));
    return;
  }
  if (!strcmp(ui->screen_id,"calendar")) {
    int y=timeline_top_inset();
    char previous_day[16]="";
    int rail=timeline_sidebar_width(ui->viewport_width);
    for(index=0;index<ui->element_count;index++) {
      AgentUiElement *e=&ui->elements[index];e->frame=GRectZero;
      if(!prv_is_rendered(e))continue;
      char day[16]="";agent_protocol_meta_get(e->meta,"day",day,sizeof(day));
      if(day[0]&&strcmp(day,previous_day)){y+=30;agent_protocol_copy(previous_day,sizeof(previous_day),day);}
      bool card=e->id[0]=='r'&&e->id[1]>='0'&&e->id[1]<='7';
      int height=card?(index==ui->selected_element?timeline_expanded_height(ui->viewport_height):timeline_compact_height(ui->viewport_height)):48;
      e->frame=GRect(timeline_left_inset(),y,ui->viewport_width-rail-timeline_left_inset()-8,height);y+=height;
    }
    // Last event can still snap to the top with room for its preview/footer.
    ui->content_height=AGENT_MAX(ui->viewport_height,y+ui->viewport_height-48);
    layer_set_frame(ui->content_layer,GRect(0,0,ui->viewport_width,ui->content_height));
    scroll_layer_set_content_size(ui->scroll_layer,GSize(ui->viewport_width,ui->content_height));
    return;
  }
  inset = prv_horizontal_inset();
  width = AGENT_MAX(40, ui->viewport_width - inset * 2);
  y = ui->title[0] ? AGENT_UI_HEADER_HEIGHT + 4 : 5;
  if(!strcmp(ui->screen_id,"event-detail"))y=100;
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
    // Layer geometry is signed 16-bit even when text is supplied remotely.
    y = (int16_t)AGENT_MIN(30000, (int32_t)y + row_height);
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

static void prv_relayout_root(AgentUi *ui);
static void prv_ensure_visible(AgentUi *ui, bool animated);
static uint32_t prv_now_ms(void) {
  time_t seconds; uint16_t milliseconds; time_ms(&seconds,&milliseconds);
  return (uint32_t)seconds*1000u+milliseconds;
}
static bool prv_input_active(AgentUi *ui) {
  return ui->input_active && (int32_t)(ui->input_until-prv_now_ms()) >= 0;
}
static void prv_paint(void *context) {
  AgentUi *ui=context;ui->refresh_timer=NULL;
  if(!ui->loaded || !ui->complete || !ui->dirty || !ui_invalidation_visible(ui->visible,ui->root_dirty))return;
  uint32_t delay=refresh_policy_screen_delay(&ui->refresh_policy,prv_now_ms(),prv_input_active(ui),ui->root_dirty);
  if(delay){ui->refresh_timer=app_timer_register(delay,prv_paint,ui);return;}
  bool new_screen=ui->root_dirty;
  if (ui->root_dirty) {
    if (ui->number_window) {
      if (window_stack_get_top_window() == number_window_get_window(ui->number_window)) {
        window_stack_pop(false);
      }
      number_window_destroy(ui->number_window);
      ui->number_window = NULL;
    }
    ui->root_dirty=false;
    prv_dismiss_menu(ui);
    scroll_layer_set_content_offset(ui->scroll_layer,GPointZero,false);
    prv_relayout_root(ui);
  }
  uint8_t work=ui_invalidation_expand(ui->dirty);
  if(work & UiDirtyGeometry)prv_calculate_layout(ui);
  if(new_screen&&!strcmp(ui->screen_id,"calendar"))prv_ensure_visible(ui,false);
  if(work & UiDirtyContent)layer_mark_dirty(ui->content_layer);
  if(work & UiDirtyActions)layer_mark_dirty(ui->action_bar_layer);
  if(work & UiDirtyClock)layer_mark_dirty(ui->status_bar_layer);
  ui->dirty=0;
  refresh_policy_painted(&ui->refresh_policy,prv_now_ms());
}
static void prv_invalidate(AgentUi *ui, uint8_t flags) {
  if(!ui)return;
  ui->dirty |= flags;
  if(!ui->loaded || !ui->complete || !ui_invalidation_visible(ui->visible,ui->root_dirty))return;
  uint32_t delay=refresh_policy_screen_delay(&ui->refresh_policy,prv_now_ms(),prv_input_active(ui),ui->root_dirty);
  if(ui->refresh_timer) {
    if(delay)return; // Already have one pending flush, not a polling timer.
    app_timer_cancel(ui->refresh_timer);ui->refresh_timer=NULL;
  }
  ui->refresh_timer=app_timer_register(delay?delay:1,prv_paint,ui);
}
static void prv_refresh(AgentUi *ui) { prv_invalidate(ui,UiDirtyAll); }

void agent_ui_note_input(AgentUi *ui) {
  if(!ui)return;
  ui->input_active=true;ui->input_until=prv_now_ms()+1000;
  refresh_policy_painted(&ui->refresh_policy,prv_now_ms());
  if(ui->dirty && ui->complete && ui->loaded) {
    if(ui->refresh_timer){app_timer_cancel(ui->refresh_timer);ui->refresh_timer=NULL;}
    prv_paint(ui); // Fresh geometry before hit-testing the user's contact.
  }
}
void agent_ui_refresh_clock(AgentUi *ui) {
  if(ui)prv_invalidate(ui,ui_invalidation_clock(!strcmp(ui->screen_id,"dashboard") || !strcmp(ui->screen_id,"calendar")));
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
  } else if (strcmp(symbol, "close") == 0) {
    graphics_context_set_stroke_width(ctx, 3);
    graphics_draw_line(ctx, GPoint(center.x - 8, center.y - 8), GPoint(center.x + 8, center.y + 8));
    graphics_draw_line(ctx, GPoint(center.x - 8, center.y + 8), GPoint(center.x + 8, center.y - 8));
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

  if (prv_control_kind(element)) {
    int32_t min = agent_protocol_meta_get_int(element->meta, "min", 0);
    int32_t max = agent_protocol_meta_get_int(element->meta, "max", 100);
    int32_t value = min; agent_protocol_parse_int32(element->value, NULL, &value);
    value = AGENT_MAX(min, AGENT_MIN(max, value));
    int32_t fraction = max > min ? (int64_t)(value - min) * TRIG_MAX_ANGLE / (max - min) : 0;
    prv_draw_text(ctx, element->title, body_font, GRect(frame.origin.x + 8, frame.origin.y + 2, frame.size.w - 16, 24),
                  GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
    char label[48], unit[16]; agent_protocol_meta_get(element->meta, "unit", unit, sizeof(unit));
    snprintf(label, sizeof(label), "%ld %s", (long)value, unit);
    graphics_context_set_stroke_color(ctx, foreground);
    graphics_context_set_fill_color(ctx, foreground);
    graphics_context_set_stroke_width(ctx, 3);
    if (prv_control_kind(element) == 1) {
      int16_t left = frame.origin.x + 14, right = frame.origin.x + frame.size.w - 14, y = frame.origin.y + 64;
      graphics_draw_line(ctx, GPoint(left, y), GPoint(right, y));
      graphics_fill_circle(ctx, GPoint(left + (int64_t)(right - left) * fraction / TRIG_MAX_ANGLE, y), 7);
      prv_draw_text(ctx, label, body_font, GRect(left, frame.origin.y + 28, right-left, 24), GTextAlignmentCenter, foreground, GTextOverflowModeTrailingEllipsis);
      char low[16], high[16]; snprintf(low, sizeof(low), "%ld", (long)min); snprintf(high, sizeof(high), "%ld", (long)max);
      prv_draw_text(ctx, low, small_font, GRect(left, frame.origin.y + 78, (right-left)/2, 20), GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
      prv_draw_text(ctx, high, small_font, GRect(left+(right-left)/2, frame.origin.y + 78, (right-left)/2, 20), GTextAlignmentRight, foreground, GTextOverflowModeTrailingEllipsis);
    } else {
      GPoint center = GPoint(frame.origin.x + frame.size.w / 2, frame.origin.y + 80);
      graphics_draw_circle(ctx, center, 43);
      graphics_draw_line(ctx, center, GPoint(center.x + (int64_t)sin_lookup(fraction) * 37 / TRIG_MAX_RATIO,
                           center.y - (int64_t)cos_lookup(fraction) * 37 / TRIG_MAX_RATIO));
      prv_draw_text(ctx, label, body_font, GRect(frame.origin.x + 8, frame.origin.y + 123, frame.size.w - 16, 24), GTextAlignmentCenter, foreground, GTextOverflowModeTrailingEllipsis);
    }
    graphics_context_set_stroke_width(ctx, 1);
    return;
  }

  if (prv_todo_row(element)) {
    int16_t cx = frame.origin.x + 13, cy = frame.origin.y + frame.size.h / 2;
    graphics_context_set_stroke_color(ctx, foreground);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_rect(ctx, GRect(cx - 7, cy - 7, 14, 14));
    if (element->flags & AGENT_UI_FLAG_CHECKED) {
      graphics_draw_line(ctx, GPoint(cx - 4, cy), GPoint(cx - 1, cy + 3));
      graphics_draw_line(ctx, GPoint(cx - 1, cy + 3), GPoint(cx + 5, cy - 4));
    }
    prv_draw_text(ctx, element->value + element->text_offset, body_font,
                  GRect(frame.origin.x + 28, frame.origin.y + 8, frame.size.w - 33, 25),
                  GTextAlignmentLeft, foreground, GTextOverflowModeTrailingEllipsis);
    return;
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
      int32_t value = 0;
      agent_protocol_parse_int32(element->value, NULL, &value);
      int16_t bar_width;
      GRect bar = GRect(frame.origin.x + 5, frame.origin.y + 29, frame.size.w - 10, 14);
      if (maximum <= minimum) {
        if (minimum == INT32_MAX) { minimum -= 1; }
        maximum = minimum + 1;
      }
      value = AGENT_MAX(minimum, AGENT_MIN(maximum, value));
      bar_width = (int16_t)((((int64_t)value - minimum) * bar.size.w) / ((int64_t)maximum - minimum));
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

// Stepped corners and a two-tone bevel match the reference's pixel panels.
static void prv_content_update_proc(Layer *layer, GContext *ctx) {
  AgentUi **slot = layer_get_data(layer);
  AgentUi *ui = slot ? *slot : NULL;
  uint8_t index;
  if (!ui) {
    return;
  }
  bool dashboard = strcmp(ui->screen_id, "dashboard") == 0;
  graphics_context_set_fill_color(ctx, dashboard ? GColorBlack : GColorWhite);
  graphics_fill_rect(ctx, layer_get_bounds(layer), 0, GCornerNone);
  if(!strcmp(ui->screen_id,"calendar")) {
    GPoint offset=scroll_layer_get_content_offset(ui->scroll_layer);
    timeline_ui_sidebar(ctx,GRect(0,-offset.y,ui->viewport_width,ui->viewport_height));
    char previous_day[16]="";
    for(index=0;index<ui->element_count;index++) {
      AgentUiElement *e=&ui->elements[index];
      if(!prv_is_rendered(e))continue;
      char day[16]="";agent_protocol_meta_get(e->meta,"day",day,sizeof(day));
      if(day[0]&&strcmp(day,previous_day)) {
        if(e->frame.origin.y>=-offset.y&&e->frame.origin.y-30<-offset.y+ui->viewport_height)
          timeline_ui_day(ctx,GRect(e->frame.origin.x,e->frame.origin.y-30,e->frame.size.w,30),day);
        agent_protocol_copy(previous_day,sizeof(previous_day),day);
      }
      if(e->frame.origin.y+e->frame.size.h<=-offset.y||e->frame.origin.y>=-offset.y+ui->viewport_height)continue;
      bool card=e->id[0]=='r'&&e->id[1]>='0'&&e->id[1]<='7';
      if(card) {
        timeline_ui_card(ctx,e->frame,e->title,e->meta,index==ui->selected_element,(e->flags&AGENT_UI_FLAG_DISABLED)!=0);
        if(index+1<ui->element_count)timeline_ui_relationship(ctx,e->frame.origin.x+14,
            e->frame.origin.y+e->frame.size.h-22,e->meta,ui->elements[index+1].meta);
      }else prv_draw_element(ui,ctx,e,index==ui->selected_element);
    }
    const char *status=ui->status[0]?ui->status:ui->subtitle;
    if(status[0] && strcmp(status,"Saved on server")) {
      GRect footer=GRect(0,-offset.y+ui->viewport_height-23,ui->viewport_width-timeline_sidebar_width(ui->viewport_width),23);
      graphics_context_set_fill_color(ctx,GColorWhite);graphics_fill_rect(ctx,footer,0,GCornerNone);
      prv_draw_text(ctx,status,fonts_get_system_font(FONT_KEY_GOTHIC_14),footer,GTextAlignmentCenter,GColorBlack,GTextOverflowModeTrailingEllipsis);
    }
    return;
  }
  if (dashboard) {
    DashboardView dashboard_view = {
      .elements=ui->elements,.element_count=ui->element_count,.selected_element=ui->selected_element,
      .dashboard_icons=ui->dashboard_icons,.artwork=&ui->artwork,
      .codex_active=ui->codex_active,.codex_remaining=ui->codex_remaining,.request_frame=ui->request_frame
    };
    dashboard_draw(&dashboard_view, ctx);
    if (ui->request_frame) {
      GRect from = prv_dashboard_frame(ui, "dictate"), to = prv_dashboard_frame(ui, "dashboard-summary");
      int t = ui->request_frame;
      int x = from.origin.x + from.size.w/2 + ((to.origin.x + to.size.w/2) - (from.origin.x + from.size.w/2))*t/20;
      int y = from.origin.y + from.size.h/2 + ((to.origin.y + to.size.h/2) - (from.origin.y + from.size.h/2))*t/20;
      graphics_context_set_fill_color(ctx, GColorBlue);
      graphics_fill_circle(ctx, GPoint(x,y), 12 - t/4);
      graphics_context_set_stroke_color(ctx, GColorWhite);
      graphics_draw_circle(ctx, GPoint(x,y), 13 - t/4);
    }
  }

  if(!strcmp(ui->screen_id,"event-detail")) {
    timeline_ui_detail_header(ctx,GRect(0,0,ui->viewport_width,96),ui->title);
  } else if (ui->title[0]) {
    int16_t header_inset = prv_header_inset();
    prv_draw_text(ctx, ui->title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                  GRect(header_inset, 1, ui->viewport_width - header_inset * 2, 31),
                  GTextAlignmentLeft, GColorBlack, GTextOverflowModeTrailingEllipsis);
    if (ui->loading && strcmp(ui->screen_id, "job-status") == 0) {
      graphics_context_set_fill_color(ctx, GColorBlack);
      int angle = ui->spinner_frame * TRIG_MAX_ANGLE / 12;
      graphics_fill_radial(ctx, GRect(ui->viewport_width - header_inset - 22, 8, 16, 16), GOvalScaleModeFitCircle, 3, angle, angle + TRIG_MAX_ANGLE / 3);
    } else if (!ui->complete || ui->loading) {
      prv_draw_text(ctx, "...", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                    GRect(ui->viewport_width - header_inset - 28, 5, 26, 22),
                    GTextAlignmentRight, GColorBlack, GTextOverflowModeTrailingEllipsis);
    }
  }

  for (index = 0; !dashboard && index < ui->element_count; index += 1) {
    AgentUiElement *element = &ui->elements[index];
    int top=-scroll_layer_get_content_offset(ui->scroll_layer).y;
    if (prv_is_rendered(element) && element->frame.origin.y+element->frame.size.h>top &&
        element->frame.origin.y<top+ui->viewport_height) {
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

static GRect prv_menu_frame(AgentUi *ui) {
  GRect bounds = layer_get_bounds(window_get_root_layer(ui->window));
  int16_t width = AGENT_MIN(176, bounds.size.w - 24);
  int16_t height = ui->menu_count * 38 + 8;
  return GRect((bounds.size.w - width) / 2, (bounds.size.h - height) / 2, width, height);
}
static GRect prv_menu_row(AgentUi *ui, int index) {
  GRect f = prv_menu_frame(ui);
  return GRect(f.origin.x + 4, f.origin.y + 4 + index * 38, f.size.w - 8, 38);
}
static void prv_menu_update(Layer *layer, GContext *ctx) {
  AgentUi *ui = *(AgentUi **)layer_get_data(layer);
  refresh_policy_painted(&ui->refresh_policy, prv_now_ms());
  if (!ui->menu_count) { return; }
  GRect target = prv_menu_frame(ui), frame = target;
  frame.size.h = AGENT_MAX(4, target.size.h * ui->menu_step / 8);
  frame.origin.y += (target.size.h - frame.size.h) / 2;
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, frame, 5, GCornersAll);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, grect_inset(frame, GEdgeInsets(2)), 3, GCornersAll);
  if (ui->menu_step < 8) { return; }
  for (uint8_t i = 0; i < ui->menu_count; ++i) {
    GRect row = prv_menu_row(ui, i);
    bool selected = i == ui->menu_selected;
    if (selected) {
      graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorBlue, GColorBlack));
      graphics_fill_rect(ctx, row, 2, GCornersAll);
    }
    prv_draw_text(ctx, ui->menu_items[i].title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                  grect_inset(row, GEdgeInsets(3, 6)), GTextAlignmentLeft,
                  selected ? GColorWhite : GColorBlack, GTextOverflowModeTrailingEllipsis);
  }
}
static void prv_menu_animate(void *context) {
  AgentUi *ui = context;
  ui->menu_timer = NULL;
  if (!ui->menu_count) { return; }
  if (ui->menu_step < 8) { ++ui->menu_step; }
  layer_mark_dirty(ui->menu_layer);
  if (ui->menu_step < 8) {
    ui->menu_timer = app_timer_register(20, prv_menu_animate, ui);
    if (!ui->menu_timer) { ui->menu_step = 8; layer_mark_dirty(ui->menu_layer); }
  }
}
static void prv_dismiss_menu(AgentUi *ui) {
  prv_reset_touch_guard(ui);
  if (ui->menu_timer) { app_timer_cancel(ui->menu_timer); ui->menu_timer = NULL; }
  ui->menu_count = 0;
  if (ui->menu_layer) { layer_set_hidden(ui->menu_layer, true); }
}
void agent_ui_open_menu(AgentUi *ui, const AgentUiMenuItem *items, uint8_t count) {
  if (!ui || !ui->menu_layer || !items || !count) { return; }
  prv_dismiss_menu(ui);
  ui->menu_count = AGENT_MIN(count, 4);
  ui->menu_selected = 0; ui->menu_step = 0;
  for (uint8_t i = 0; i < ui->menu_count; ++i) {
    agent_protocol_copy(ui->menu_items[i].title, sizeof(ui->menu_items[i].title), items[i].title);
    agent_protocol_copy(ui->menu_items[i].action, sizeof(ui->menu_items[i].action), items[i].action);
  }
  layer_set_hidden(ui->menu_layer, false);
  prv_menu_animate(ui);
}
static void prv_agent_menu(AgentUi *ui) {
  const AgentUiMenuItem items[] = {{"Talk to codey", "local.dictate"}, {"New Chat", "local.new-chat"}};
  agent_ui_open_menu(ui, items, 2);
}
static void prv_menu_select(AgentUi *ui, int index) {
  char action[AGENT_UI_ACTION_LENGTH];
  if (index < 0 || index >= ui->menu_count) { prv_dismiss_menu(ui); return; }
  agent_protocol_copy(action, sizeof(action), ui->menu_items[index].action);
  prv_dismiss_menu(ui);
  prv_emit(ui, "select", NULL, action, "");
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
  scroll_layer_set_shadow_hidden(ui->scroll_layer,!strcmp(ui->screen_id,"calendar")||!strcmp(ui->screen_id,"event-detail"));
  status_visible = (ui->screen_flags & AGENT_UI_FLAG_STATUS) != 0;
  if(!strcmp(ui->screen_id,"calendar"))status_visible=false;
  action_visible = prv_has_action_bar(ui);
  top = status_visible ? STATUS_BAR_LAYER_HEIGHT : 0;
#if defined(PBL_ROUND)
  // A hidden status bar still needs equivalent breathing room so custom
  // content does not begin in the clipped crown of the circle.
  if (!status_visible) { top = STATUS_BAR_LAYER_HEIGHT; }
  if (strcmp(ui->screen_id, "dashboard") == 0) { top = 0; }
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
  layer_set_hidden(ui->status_bar_layer, !status_visible);
  layer_set_hidden(ui->action_bar_layer, !action_visible);
  layer_set_frame(ui->action_bar_layer,
                  GRect(bounds.size.w - action_width, action_top, action_width, action_height));
  layer_set_frame(scroll_layer_get_layer(ui->scroll_layer),
                  GRect(0, top, bounds.size.w - action_width, bounds.size.h - top));
  ui->viewport_width = bounds.size.w - action_width;
  ui->viewport_height = bounds.size.h - top;
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
  if(!strcmp(ui->screen_id,"calendar")) {
    int top=element->frame.origin.y;
    char day[16]="",prev[16]="";agent_protocol_meta_get(element->meta,"day",day,sizeof(day));
    if(ui->selected_element>0)agent_protocol_meta_get(ui->elements[ui->selected_element-1].meta,"day",prev,sizeof(prev));
    if(day[0]&&strcmp(day,prev))top-=30;
    int focus_inset=timeline_top_inset()?timeline_top_inset()+30:0;
    scroll_layer_set_content_offset(ui->scroll_layer,GPoint(0,-AGENT_MAX(0,top-focus_inset)),animated);
    return;
  }
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
  if(!strcmp(ui->screen_id,"calendar")) {
    AgentUiElement *binding=prv_find_binding(ui,direction>0?"timeline-next":"timeline-previous");
    bool edge=direction<0?ui->selected_element==0:
      ui->selected_element>=0 && ui->selected_element+1<ui->element_count &&
      !strcmp(ui->elements[ui->selected_element+1].id,"next");
    if(binding&&edge){prv_emit_binding(ui,direction>0?"down":"up",binding);return;}
  }
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
    if(!strcmp(ui->screen_id,"calendar"))return;
    prv_scroll(ui, direction > 0 ? -42 : 42, true);
    return;
  }
  if(!strcmp(ui->screen_id,"calendar")) {
    ui->selected_element=index;
    prv_calculate_layout(ui);
    prv_ensure_visible(ui,true);
    layer_mark_dirty(ui->content_layer);
    return;
  }
  // Read the content between actions instead of jumping over it.
  GPoint offset = scroll_layer_get_content_offset(ui->scroll_layer);
  GRect frame = ui->elements[index].frame;
  if ((direction > 0 && frame.origin.y >= -offset.y + ui->viewport_height) ||
      (direction < 0 && frame.origin.y + frame.size.h <= -offset.y)) {
    prv_scroll(ui, direction > 0 ? -42 : 42, true);
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
  window_stack_pop(true);
  ui->editing_element = -1;
  prv_emit(ui, "field", element, element->action, element->value);
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
  value = 0;
  agent_protocol_parse_int32(element->value, NULL, &value);
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
  if (strcmp(element->action, "local.submit") == 0) {
    char target[32]; agent_protocol_meta_get(element->meta, "control", target, sizeof(target));
    AgentUiElement *control = prv_find_element(ui, target);
    if (control && prv_control_kind(control) && !(control->flags & AGENT_UI_FLAG_DISABLED)) {
      control->flags |= AGENT_UI_FLAG_DISABLED;
      prv_emit(ui, "field", control, control->action, control->value);
    }
    return;
  }
  ui->selected_element = prv_index_of(ui, element);
  layer_mark_dirty(ui->content_layer);
  if (element->kind == AgentUiElementField &&
      agent_protocol_meta_get(element->meta, "type", field_type, sizeof(field_type)) &&
      (strcmp(field_type, "number") == 0 || prv_control_kind(element))) {
    prv_open_number(ui, element);
    return;
  }
  prv_emit(ui, input, element, element->action, element->value);
}

static void prv_handle_input(AgentUi *ui, const char *input) {
  prv_input(ui);
  prv_reset_touch_guard(ui);
  if (ui->menu_count) {
    if (strcmp(input, "up") == 0 && ui->menu_selected) { --ui->menu_selected; }
    else if (strcmp(input, "down") == 0 && ui->menu_selected + 1 < ui->menu_count) { ++ui->menu_selected; }
    else if (strcmp(input, "select") == 0) { prv_menu_select(ui, ui->menu_selected); return; }
    layer_mark_dirty(ui->menu_layer); return;
  }
  if (strcmp(ui->screen_id, "dashboard") == 0) {
    if (strcmp(input, "up") == 0) { prv_emit(ui, input, NULL, "local.dashboard.notifications", ""); return; }
    if (strcmp(input, "down") == 0) { AgentUiElement *tile=prv_find_element(ui,"todos");prv_emit(ui, input, NULL, tile?tile->action:"local.todos", ""); return; }
    if (strcmp(input, "select") == 0) { prv_emit(ui, input, NULL, "local.dictate", ""); return; }
  }
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
  prv_input(ui);
  prv_reset_touch_guard(ui);
  if (ui->menu_count) { prv_dismiss_menu(ui); return; }
  binding = prv_find_binding(ui, "back");
  if (binding) {
    prv_emit_binding(ui, "back", binding);
  } else if (strcmp(ui->screen_id, "dashboard") != 0) {
    prv_emit(ui, "back", NULL, "local.home", "");
  } else {
    window_stack_pop(true);
  }
}

static void prv_collection_menu(AgentUi *ui){const AgentUiMenuItem items[]={{"To Do","local.todos"},{"Notes","local.notes"}};agent_ui_open_menu(ui,items,2);}
static void prv_down_long_click(ClickRecognizerRef r,void *context){(void)r;AgentUi *ui=context;prv_input(ui);prv_reset_touch_guard(ui);prv_collection_menu(ui);}
static void prv_select_long_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  (void)recognizer;
  prv_input(ui);
  prv_reset_touch_guard(ui);
  if (ui->menu_count) { return; }
  if (strcmp(ui->screen_id, "dashboard") == 0) { prv_agent_menu(ui); return; }
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
                          (int32_t)AGENT_MIN((int64_t)ui->editing_max, (int64_t)value + ui->editing_step));
}

static void prv_number_down_click(ClickRecognizerRef recognizer, void *context) {
  AgentUi *ui = context;
  int32_t value;
  (void)recognizer;
  if (!ui || !ui->number_window) { return; }
  value = number_window_get_value(ui->number_window);
  number_window_set_value(ui->number_window,
                          (int32_t)AGENT_MAX((int64_t)ui->editing_min, (int64_t)value - ui->editing_step));
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

static void prv_todo_left(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer; AgentUi *ui = context;
  if (ui->selected_element >= 0) { prv_pan_todo(ui, &ui->elements[ui->selected_element], -1); }
}

static void prv_click_config_provider(void *context) {
  (void)context;
  if (prv_todo_screen(context)) {
    window_single_click_subscribe(BUTTON_ID_UP, prv_up_click);
    window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click);
    window_long_click_subscribe(BUTTON_ID_UP, 450, prv_todo_left, NULL);
    window_long_click_subscribe(BUTTON_ID_DOWN, 450, prv_down_long_click, NULL);
  } else {
    window_single_repeating_click_subscribe(BUTTON_ID_UP, 180, prv_up_click);
    window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click);
  }
  window_long_click_subscribe(BUTTON_ID_DOWN,450,prv_down_long_click,NULL);
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
    left = AGENT_MAX(0, AGENT_MIN(100, left));
    top = AGENT_MAX(0, AGENT_MIN(100, top));
    width = AGENT_MAX(0, AGENT_MIN(100 - left, width));
    height = AGENT_MAX(0, AGENT_MIN(100 - top, height));
    frame = GRect(bounds.size.w * left / 100, bounds.size.h * top / 100,
                  bounds.size.w * width / 100, bounds.size.h * height / 100);
    if (grect_contains_point(&frame, &point)) { return element; }
  }
  return NULL;
}

static void prv_cancel_hold(AgentUi *ui) {
  if (ui->hold_timer) { app_timer_cancel(ui->hold_timer); ui->hold_timer = NULL; }
}
static void prv_touch_hold(void *context) {
  AgentUi *ui = context; ui->hold_timer = NULL;
  if (ui->touch_down && !ui->touch_dragged && strcmp(ui->screen_id, "dashboard") == 0) {
    ui->touch_consumed = true;
    AgentUiElement *hit = prv_hit_test(ui, ui->touch_down_x, ui->touch_down_y);
    if (hit && (!strcmp(hit->id, "todos") || !strcmp(hit->id,"calendar"))) {
      prv_collection_menu(ui);
    } else prv_agent_menu(ui);
  }
}

static void prv_control_touch(AgentUi *ui, int x, int y, bool first) {
  if (ui->touch_control < 0 || ui->touch_control >= ui->element_count) { return; }
  AgentUiElement *e = &ui->elements[ui->touch_control];
  int32_t min = agent_protocol_meta_get_int(e->meta, "min", 0), max = agent_protocol_meta_get_int(e->meta, "max", 100);
  int32_t step = agent_protocol_meta_get_int(e->meta, "step", 1), value = min;
  if (min >= max || min < 0 || max > 604800) { return; }
  if (prv_control_kind(e) == 1) {
    value = range_slider(x - e->frame.origin.x - 14, e->frame.size.w - 28, min, max, step);
  } else {
    int dx = x - (e->frame.origin.x + e->frame.size.w / 2);
    int dy = y - (e->frame.origin.y + 80);
    if (first) { agent_protocol_parse_int32(e->value, NULL, &value); ui->touch_raw_value = (int64_t)value * TRIG_MAX_ANGLE; }
    if (dx * dx + dy * dy < 100) { ui->touch_angle = -1; return; }
    int32_t angle = atan2_lookup(dx, -dy);
    if (angle < 0) { angle += TRIG_MAX_ANGLE; }
    if (!first && ui->touch_angle >= 0) { ui->touch_raw_value += (int64_t)range_angle_delta(angle, ui->touch_angle) * (max - min); }
    ui->touch_angle = angle;
    ui->touch_raw_value = AGENT_MAX((int64_t)min * TRIG_MAX_ANGLE, AGENT_MIN((int64_t)max * TRIG_MAX_ANGLE, ui->touch_raw_value));
    value = range_quantize(ui->touch_raw_value / TRIG_MAX_ANGLE, min, max, step);
  }
  snprintf(e->value, sizeof(e->value), "%ld", (long)value);
  layer_mark_dirty(ui->content_layer);
}
static int prv_content_y(AgentUi *ui, int y) {
  return y - layer_get_frame(scroll_layer_get_layer(ui->scroll_layer)).origin.y - scroll_layer_get_content_offset(ui->scroll_layer).y;
}

static uint32_t prv_touch_now(void) {
  time_t seconds; uint16_t milliseconds;
  time_ms(&seconds, &milliseconds);
  return (uint32_t)seconds * 1000u + milliseconds;
}
static int prv_touch_target(AgentUi *ui, int x, int y) {
  if (ui->menu_count) {
    GPoint point = GPoint(x,y);
    for (uint8_t i = 0; i < ui->menu_count; ++i) {
      GRect row = prv_menu_row(ui,i);
      if (grect_contains_point(&row,&point)) { return 1000 + i; }
    }
    return 1100; // Outside-menu dismissal is guarded too.
  }
  if (prv_has_action_bar(ui)) {
    GRect frame = layer_get_frame(ui->action_bar_layer);
    if (x >= frame.origin.x) {
      int section = (y-frame.origin.y)*3 / AGENT_MAX(1,frame.size.h);
      return 2000 + AGENT_MAX(0,AGENT_MIN(2,section));
    }
  }
  AgentUiElement *hit = prv_hotspot(ui,x,y);
  if (!hit) { hit = prv_hit_test(ui,x,y); }
  if (!hit) { return 3000; }
  // Reading/panning todo text must not arm its adjacent checkbox.
  int region = prv_todo_row(hit) && x >= hit->frame.origin.x + 28 ? 100 : 0;
  // IDs/actions keep the arm attached to the same semantic control even if
  // an asynchronous patch replaces a slot between contacts.
  uint32_t key = 2166136261u;
  const char *parts[] = { hit->id, hit->action };
  for (unsigned i=0;i<2;++i) {
    for (const char *p=parts[i];*p;++p) { key = (key ^ (uint8_t)*p) * 16777619u; }
    key = (key ^ 0xffu) * 16777619u;
  }
  return (int32_t)(0x80000000u | ((key ^ (uint32_t)region) & 0x7fffffffu));
}

static GPoint prv_ripple_point(AgentUi *ui, int radius, int angle, GSize size) {
  int dx = (int64_t)sin_lookup(angle)*radius/TRIG_MAX_RATIO;
  int dy = (int64_t)cos_lookup(angle)*radius/TRIG_MAX_RATIO;
#if defined(PBL_ROUND)
  RipplePoint p = ripple_round(ui->ripple_origin.x, ui->ripple_origin.y, dx, dy, size.w);
  return GPoint(p.x, p.y);
#else
  return GPoint(ripple_reflect(ui->ripple_origin.x+dx,size.w), ripple_reflect(ui->ripple_origin.y+dy,size.h));
#endif
}
static void prv_ripple_draw(Layer *layer, GContext *ctx) {
  AgentUi *ui = *(AgentUi **)layer_get_data(layer);
  if (!ui->ripple_frame) return;
  GRect bounds = layer_get_bounds(layer);
  int radius = ripple_radius(bounds.size.w, ui->ripple_frame);
  // Pebble has no alpha-composited layers. Spatially dither the thin wave
  // so its coverage fades to zero over its fixed travel budget.
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorBlack));
  graphics_context_set_stroke_width(ctx, 2);
  for (int angle=0;angle<180;angle++) {
    if ((angle * 7) % RIPPLE_FRAMES >= RIPPLE_FRAMES - ui->ripple_frame) continue;
    int a = angle * TRIG_MAX_ANGLE / 180, b = (angle+1) * TRIG_MAX_ANGLE / 180;
    GPoint p = prv_ripple_point(ui, radius, a, bounds.size);
    GPoint q = prv_ripple_point(ui, radius, b, bounds.size);
    graphics_draw_line(ctx,p,q);
  }
  refresh_policy_painted(&ui->refresh_policy, prv_now_ms());
}
static void prv_ripple_tick(void *context) {
  AgentUi *ui = context; ui->ripple_timer = NULL;
  if (++ui->ripple_frame >= RIPPLE_FRAMES) { prv_stop_ripple(ui); return; }
  layer_mark_dirty(ui->ripple_layer);
  ui->ripple_timer = app_timer_register(RIPPLE_INTERVAL_MS, prv_ripple_tick, ui);
  if (!ui->ripple_timer) prv_stop_ripple(ui);
}
static void prv_start_ripple(AgentUi *ui, int x, int y) {
  prv_stop_ripple(ui);
  if (!ui->ripple_layer || !ui->tap_animation) return;
  ui->ripple_origin = GPoint(x,y); ui->ripple_frame = 1;
  layer_set_hidden(ui->ripple_layer, false);
  layer_mark_dirty(ui->ripple_layer);
  ui->ripple_timer = app_timer_register(RIPPLE_INTERVAL_MS, prv_ripple_tick, ui);
  if (!ui->ripple_timer) prv_stop_ripple(ui);
}

static void prv_touch_handler(const TouchEvent *event, void *context) {
  AgentUi *ui = context;
  int dx;
  int dy;
  if (!ui || !event) { return; }
  // Firmware marks contacts that must not navigate. Reject before scrolling,
  // arming, adjusting a control, or scheduling a hold callback.
  if (event->non_navigational) {
    prv_reset_touch_guard(ui);
    return;
  }
  // Reading drags bypass arming, but never activate a control or swipe binding.
  if (event->type == TouchEvent_Touchdown) {
    AgentUiElement *hit = prv_hit_test(ui, event->x, event->y);
    GRect viewport = layer_get_frame(scroll_layer_get_layer(ui->scroll_layer));
    GPoint point = GPoint(event->x, event->y);
    bool eligible = !ui->menu_count && strcmp(ui->screen_id, "dashboard") &&
                    ui->content_height > ui->viewport_height &&
                    grect_contains_point(&viewport, &point) &&
                    !prv_hotspot(ui, event->x, event->y) && !prv_control_kind(hit);
    scroll_gesture_down(&ui->gesture.scroll, eligible, event->x, event->y);
  } else if (event->type == TouchEvent_PositionUpdate) {
    int delta;
    if (scroll_gesture_move(&ui->gesture.scroll, event->x, event->y, &delta)) {
      prv_cancel_hold(ui);
      touch_guard_reset(&ui->gesture.guard);
      ui->touch_down = false;
      prv_scroll(ui, delta, false);
      return;
    }
  } else if (event->type == TouchEvent_Liftoff && scroll_gesture_up(&ui->gesture.scroll)) {
    if(!strcmp(ui->screen_id,"calendar")) {
      int top=-scroll_layer_get_content_offset(ui->scroll_layer).y,best=-1,distance=32767;
      for(int i=0;i<ui->element_count;i++)if(prv_is_selectable(&ui->elements[i])) {
        int d=abs(ui->elements[i].frame.origin.y-top);
        if(d<distance){best=i;distance=d;}
      }
      if(best>=0){ui->selected_element=best;prv_calculate_layout(ui);prv_ensure_visible(ui,true);layer_mark_dirty(ui->content_layer);}
    }
    prv_reset_touch_guard(ui);
    return;
  }
  // Other gestures still require an arming tap.
  if (event->type == TouchEvent_Touchdown) { prv_stop_ripple(ui); prv_input(ui); }
  GestureContact phase;
  switch (event->type) {
    case TouchEvent_Touchdown: prv_cancel_hold(ui); phase=GestureDown; break;
    case TouchEvent_PositionUpdate: phase=GestureMove; break;
    case TouchEvent_Liftoff: phase=GestureUp; break;
    default: prv_reset_touch_guard(ui); return;
  }
  bool allowed=gesture_controller_contact(&ui->gesture,phase,
      phase==GestureMove?0:prv_touch_target(ui,event->x,event->y),event->x,event->y,
      phase==GestureMove?0:prv_touch_now(),ui->double_tap);
  if(phase==GestureDown&&!ui->double_tap)prv_start_ripple(ui,event->x,event->y);
  if (!allowed) {
    if (event->type == TouchEvent_Liftoff) {
      ui->touch_down = false; prv_cancel_hold(ui);
      if (ui->gesture.guard.armed) prv_start_ripple(ui, ui->gesture.guard.x, ui->gesture.guard.y);
    }
    return;
  }
  switch (event->type) {
    case TouchEvent_Touchdown:
      prv_cancel_hold(ui);
      ui->touch_consumed = false;
      ui->touch_control = -1;
      ui->touch_horizontal = ui->touch_vertical = false;
      ui->touch_was_menu = ui->menu_count != 0;
      ui->touch_last_x = event->x;
      ui->touch_down = true;
      ui->touch_dragged = false;
      ui->touch_down_x = event->x;
      ui->touch_down_y = event->y;
      ui->touch_last_y = event->y;
      if (!ui->menu_count) {
        AgentUiElement *hit = prv_hit_test(ui, event->x, event->y);
        if (prv_control_kind(hit) && !(hit->flags & AGENT_UI_FLAG_DISABLED) && prv_content_y(ui, event->y) >= hit->frame.origin.y + 28) {
          ui->touch_control = prv_index_of(ui, hit); ui->selected_element = ui->touch_control;
          prv_control_touch(ui, event->x, prv_content_y(ui, event->y), true);
        }
        ui->touch_row = prv_todo_row(hit);
        if (ui->touch_row) { ui->selected_element = prv_index_of(ui, hit); }
        if (hit && (!strcmp(hit->id, "dictate") || !strcmp(hit->id, "todos") || !strcmp(hit->id,"calendar")) && strcmp(ui->screen_id, "dashboard") == 0) {
          ui->hold_timer = app_timer_register(AGENT_UI_SELECT_HOLD_MS, prv_touch_hold, ui);
        }
      }
      break;
    case TouchEvent_PositionUpdate:
      if (!ui->touch_down || ui->touch_consumed || ui->touch_was_menu) { break; }
      if (ui->touch_control >= 0) { prv_control_touch(ui, event->x, prv_content_y(ui, event->y), false); break; }
      if (prv_abs(event->x - ui->touch_down_x) > AGENT_UI_TOUCH_TAP_MAX ||
          prv_abs(event->y - ui->touch_down_y) > AGENT_UI_TOUCH_TAP_MAX) {
        ui->touch_dragged = true;
        prv_cancel_hold(ui);
        if (!ui->touch_horizontal && !ui->touch_vertical) {
          ui->touch_horizontal = ui->touch_row && prv_abs(event->x - ui->touch_down_x) > prv_abs(event->y - ui->touch_down_y);
          ui->touch_vertical = !ui->touch_horizontal;
        }
      }
      if (ui->touch_horizontal) {
        if (prv_abs(event->x - ui->touch_last_x) >= 12 && ui->selected_element >= 0) {
          prv_pan_todo(ui, &ui->elements[ui->selected_element], event->x < ui->touch_last_x ? 1 : -1);
          ui->touch_last_x = event->x;
        }
        break;
      }
      dy = event->y - ui->touch_last_y;
      if (dy && !ui->gesture.scroll.eligible) { prv_scroll(ui, dy, false); }
      ui->touch_last_y = event->y;
      break;
    case TouchEvent_Liftoff:
      if (!ui->touch_down) { break; }
      ui->touch_down = false;
      prv_cancel_hold(ui);
      if (ui->touch_control >= 0) { ui->touch_control = -1; break; }
      if (ui->touch_consumed) { ui->touch_consumed = false; break; }
      if (ui->touch_was_menu) {
        if (ui->gesture.guard.moved || prv_touch_target(ui,event->x,event->y) != ui->gesture.guard.target) { break; }
        GPoint tap = GPoint(event->x, event->y);
        int selected = -1;
        for (uint8_t i = 0; i < ui->menu_count; ++i) {
          GRect row = prv_menu_row(ui, i);
          if (grect_contains_point(&row, &tap)) { selected = i; break; }
        }
        prv_menu_select(ui, selected); break;
      }
      if (ui->touch_horizontal) { break; }
      dx = event->x - ui->touch_down_x;
      dy = event->y - ui->touch_down_y;
      if (prv_abs(dx) > AGENT_UI_TOUCH_SWIPE_MIN && prv_abs(dx) > prv_abs(dy)) {
        const char *gesture = dx > 0 ? "swipe-right" : "swipe-left";
        AgentUiElement *binding = prv_find_binding(ui, gesture);
        if (binding) { prv_emit_binding(ui, gesture, binding); }
        else if (prv_todo_screen(ui) && ui->selected_element >= 0) { prv_pan_todo(ui, &ui->elements[ui->selected_element], dx < 0 ? 1 : -1); }
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
        } else if (prv_todo_row(element) && ui->touch_down_x >= element->frame.origin.x + 28) {
          ui->selected_element = prv_index_of(ui, element); layer_mark_dirty(ui->content_layer);
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

static void prv_clock_update(Layer *layer,GContext *ctx) {
  GRect bounds=layer_get_bounds(layer); char clock[16];clock_copy_time_string(clock,sizeof(clock));
  graphics_context_set_fill_color(ctx,GColorWhite);graphics_fill_rect(ctx,bounds,0,GCornerNone);
  prv_draw_text(ctx,clock,fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),GRect(0,-2,bounds.size.w,18),GTextAlignmentCenter,GColorBlack,GTextOverflowModeTrailingEllipsis);
  graphics_context_set_stroke_color(ctx,GColorBlack);
  for(int x=0;x<bounds.size.w;x+=2)graphics_draw_pixel(ctx,GPoint(x,STATUS_BAR_LAYER_HEIGHT-1));
}
static void prv_window_load(Window *window) {
  AgentUi *ui = window_get_user_data(window);
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  AgentUi **slot;
  ui->menu_layer = layer_create_with_data(bounds, sizeof(AgentUi *));
  if (ui->menu_layer) {
    *(AgentUi **)layer_get_data(ui->menu_layer) = ui;
    layer_set_update_proc(ui->menu_layer, prv_menu_update);
    layer_set_hidden(ui->menu_layer, true);
  }
  ui->status_bar_layer = layer_create(GRect(0,0,bounds.size.w,STATUS_BAR_LAYER_HEIGHT));
  if (!ui->status_bar_layer) { return; }
  layer_set_update_proc(ui->status_bar_layer,prv_clock_update);
  layer_add_child(root, ui->status_bar_layer);

  ui->scroll_layer = scroll_layer_create(bounds);
  if (!ui->scroll_layer) { return; }
  layer_add_child(root, scroll_layer_get_layer(ui->scroll_layer));
  ui->content_layer = layer_create_with_data(bounds, sizeof(AgentUi *));
  if (!ui->content_layer) { return; }
  slot = layer_get_data(ui->content_layer);
  *slot = ui;
  layer_set_update_proc(ui->content_layer, prv_content_update_proc);
  scroll_layer_add_child(ui->scroll_layer, ui->content_layer);

  ui->action_bar_layer = layer_create_with_data(GRect(bounds.size.w, 0, 0, bounds.size.h),
                                                 sizeof(AgentUi *));
  if (!ui->action_bar_layer) { return; }
  slot = layer_get_data(ui->action_bar_layer);
  *slot = ui;
  layer_set_update_proc(ui->action_bar_layer, prv_action_bar_update_proc);
  layer_add_child(root, ui->action_bar_layer);
  if (ui->menu_layer) { layer_add_child(root, ui->menu_layer); }

#if defined(PBL_TOUCH)
  ui->double_tap = !persist_exists(4396) || persist_read_int(4396)!=0;
  ui->tap_animation = !persist_exists(4397) || persist_read_int(4397) != 0;
  ui->ripple_layer = layer_create_with_data(bounds, sizeof(AgentUi *));
  if (ui->ripple_layer) {
    *(AgentUi **)layer_get_data(ui->ripple_layer) = ui;
    layer_set_update_proc(ui->ripple_layer, prv_ripple_draw);
    layer_set_hidden(ui->ripple_layer, true);
    layer_add_child(root, ui->ripple_layer);
  }
#endif
  ui->loaded = true;
  prv_relayout_root(ui);
  agent_ui_note_input(ui);
  prv_refresh(ui);
}

static void prv_window_unload(Window *window) {
  AgentUi *ui = window_get_user_data(window);
#if defined(PBL_TOUCH)
  prv_stop_ripple(ui);
  if (ui->ripple_layer) { layer_destroy(ui->ripple_layer); ui->ripple_layer = NULL; }
#endif
#if defined(PBL_TOUCH)
  prv_cancel_hold(ui);
#endif
  ui->loaded = false;
  prv_dismiss_menu(ui);
  if (ui->menu_layer) { layer_destroy(ui->menu_layer); ui->menu_layer = NULL; }
  if (ui->action_bar_layer) { layer_destroy(ui->action_bar_layer); ui->action_bar_layer = NULL; }
  if (ui->content_layer) { layer_destroy(ui->content_layer); ui->content_layer = NULL; }
  if (ui->scroll_layer) { scroll_layer_destroy(ui->scroll_layer); ui->scroll_layer = NULL; }
  if (ui->status_bar_layer) { layer_destroy(ui->status_bar_layer); ui->status_bar_layer = NULL; }
}

static void prv_window_appear(Window *window) {
  AgentUi *ui = window_get_user_data(window);
  ui->visible=true;
  ui->refresh_policy.painted=false;
  agent_ui_refresh_clock(ui);
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
  prv_reset_touch_guard(window_get_user_data(window));
  AgentUi *ui = window_get_user_data(window);
  ui->visible=false;
  if(ui->refresh_timer){app_timer_cancel(ui->refresh_timer);ui->refresh_timer=NULL;}
  prv_stop_activity(ui);
#if defined(PBL_TOUCH)
  prv_cancel_hold(ui);
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
  ui->codex_remaining = ui->codex_active = -1;
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
  const uint32_t icons[DashboardIconCount] = {
    [DashboardCalendar] = RESOURCE_ID_DASH_CALENDAR,
    [DashboardWeather] = RESOURCE_ID_DASH_WEATHER,
    [DashboardTodos] = RESOURCE_ID_DASH_TODOS,
    [DashboardSleep] = RESOURCE_ID_DASH_CODEY_SLEEP_SMALL,
    [DashboardThink] = RESOURCE_ID_DASH_CODEY_THINK_SMALL,
    [DashboardTimer] = RESOURCE_ID_DASH_TIMER_SMALL,
    [DashboardAlarm] = RESOURCE_ID_DASH_ALARM_SMALL,
  };
  for (int i = 0; i < DashboardIconCount; ++i) { ui->dashboard_icons[i] = gbitmap_create_with_resource(icons[i]); }
  return ui;
}

void agent_ui_destroy(AgentUi *ui) {
  if (!ui) { return; }
#if defined(PBL_TOUCH)
  if (ui->touch_subscribed) { touch_service_unsubscribe(); }
#endif
  if (ui->refresh_timer) { app_timer_cancel(ui->refresh_timer); }
  prv_stop_activity(ui);
  if (ui->number_window) { number_window_destroy(ui->number_window); }
  if (ui->window) { window_destroy(ui->window); }
  for (int i = 0; i < DashboardIconCount; ++i) { if (ui->dashboard_icons[i]) { gbitmap_destroy(ui->dashboard_icons[i]); } }
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
  ui->root_dirty=true;
  if(!screen_id || strcmp(screen_id,"dashboard"))prv_stop_activity(ui);
#if defined(PBL_TOUCH)
  prv_cancel_hold(ui);
  ui->touch_down = false;
  ui->touch_control = -1;
#endif
  ui->editing_element = -1;
  // Slots are initialized when added; all readers use the live count.
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
    window_set_click_config_provider_with_context(ui->window, prv_click_config_provider, ui);
  }
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
  agent_ui_element_apply(element, spec, false);
  if (prv_is_selectable(element) && (ui->selected_element < 0 || (element->flags & AGENT_UI_FLAG_SELECTED) ||
      (strcmp(ui->screen_id, "dashboard") == 0 && strcmp(element->action, "local.dictate") == 0))) {
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
  if (!agent_ui_element_apply(element, spec, true)) { return true; }
  prv_refresh(ui);
  return true;
}

bool agent_ui_append(AgentUi *ui, const char *element_id, const char *value) {
  AgentUiElement *element = prv_find_element(ui, element_id);
  size_t available;
  if (!element || !value) { return false; }
  available = sizeof(element->value) - strlen(element->value) - 1;
  if (available) {
    agent_protocol_copy(element->value + strlen(element->value), available + 1, value);
  }
  prv_refresh(ui);
  return true;
}

bool agent_ui_remove(AgentUi *ui, const char *element_id) {
  AgentUiElement *element = prv_find_element(ui, element_id);
  int16_t index;
  if (!element) { return false; }
  index = prv_index_of(ui, element);
  if (ui->editing_element == index) {
    if (ui->number_window && window_stack_get_top_window() == number_window_get_window(ui->number_window)) {
      window_stack_pop(false);
    }
    ui->editing_element = -1;
  } else if (ui->editing_element > index) { ui->editing_element -= 1; }
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
  if (ui->selected_element >= 0 &&
      (ui->elements[ui->selected_element].flags & AGENT_UI_FLAG_SELECTED)) {
    prv_ensure_visible(ui, false);
  }
}

static void prv_show_error(AgentUi *ui, const char *reason) {
  char details[AGENT_UI_VALUE_LENGTH];
  agent_protocol_copy(details, sizeof(details), reason && reason[0] ? reason : "The request could not be completed.");
  agent_ui_begin(ui, "request-error", "list", "Request failed", "", "", 0);
  agent_ui_add(ui, &(AgentUiElementSpec) { .kind = "text", .id = "error-reason", .value = details });
  agent_ui_add(ui, &(AgentUiElementSpec) { .kind = "item", .id = "error-retry", .title = "Try again",
    .subtitle = "Speak your request again", .action = "local.dictate" });
  agent_ui_add(ui, &(AgentUiElementSpec) { .kind = "item", .id = "error-home", .title = "Dashboard", .action = "local.home" });
  agent_ui_end(ui);
}

static void prv_activity_tick(void *context) {
  AgentUi *ui = context;
  ui->activity_timer = NULL;
  if (ui->request_frame) {
    if (strcmp(ui->screen_id,"dashboard") != 0 || ++ui->request_frame > 20) { ui->request_frame = 0; }
  }
  if (!ui->request_frame) artwork_cache_clear(&ui->artwork);
  ui->spinner_frame = (ui->spinner_frame + 1) % 12;
  if (ui->content_layer) { layer_mark_dirty(ui->content_layer); }
  if (ui->request_frame) {
    ui->activity_timer = app_timer_register(30, prv_activity_tick, ui);
    if (!ui->activity_timer) prv_stop_activity(ui);
  }
}
void agent_ui_animate_request(AgentUi *ui) {
  if (!ui || !ui->loaded || strcmp(ui->screen_id,"dashboard")) { return; }
  ui->request_frame = 1;
  if (!ui->activity_timer) { ui->activity_timer = app_timer_register(30, prv_activity_tick, ui); }
  if (!ui->activity_timer) prv_stop_activity(ui);
}

void agent_ui_set_status(AgentUi *ui, const char *status, bool is_error, bool loading) {
  if (!ui) { return; }
  if (is_error) { ui->error_revision++;prv_show_error(ui, status); return; }
  if(ui->loading==loading && ui->error==is_error && strcmp(ui->status,status?status:"")==0)return;
  bool geometry_changed=!!ui->status[0] != !!(status && status[0]);
  agent_protocol_copy(ui->status, sizeof(ui->status), status);
  ui->error = is_error;
  ui->loading = loading;

  if (is_error) { ui->complete = true; }
  prv_invalidate(ui, geometry_changed ? UiDirtyGeometry : UiDirtyContent);
}

uint32_t agent_ui_error_revision(const AgentUi *ui) { return ui ? ui->error_revision : 0; }

const char *agent_ui_screen_id(const AgentUi *ui) {
  return ui ? ui->screen_id : "";
}

const char *agent_ui_layout_name(const AgentUi *ui) {
  return ui ? ui->layout_name : "";
}

void agent_ui_set_tap_animation(AgentUi *ui, bool enabled) {
  if (!persist_exists(4397) || (persist_read_int(4397)!=0)!=enabled) persist_write_int(4397,enabled?1:0);
#if defined(PBL_TOUCH)
  if(ui){ui->tap_animation=enabled;if(!enabled)prv_stop_ripple(ui);}
#else
  (void)ui;
#endif
}

void agent_ui_set_codex_status(AgentUi *ui,int remaining,int active,const char *state){
  if(!ui)return;
  remaining=remaining<0?-1:AGENT_MIN(100,remaining);active=active<0?-1:active;
  if(ui->codex_remaining==remaining && ui->codex_active==active && !strcmp(ui->codex_state,state))return;
  ui->codex_remaining=remaining;ui->codex_active=active;agent_protocol_copy(ui->codex_state,sizeof(ui->codex_state),state);
  if(!strcmp(ui->screen_id,"dashboard"))prv_invalidate(ui,UiDirtyContent);
}

void agent_ui_set_double_tap(AgentUi *ui,bool enabled){
#if defined(PBL_TOUCH)
 ui->double_tap=enabled;prv_reset_touch_guard(ui);if(!persist_exists(4396)||(persist_read_int(4396)!=0)!=enabled)persist_write_int(4396,enabled?1:0);
#else
 (void)ui;(void)enabled;
#endif
}
