#pragma once

#include <pebble.h>

#define AGENT_UI_ID_LENGTH 32
#define AGENT_UI_KIND_LENGTH 16
#define AGENT_UI_TITLE_LENGTH 72
#define AGENT_UI_SUBTITLE_LENGTH 100
#define AGENT_UI_VALUE_LENGTH 320
#define AGENT_UI_ACTION_LENGTH 48
#define AGENT_UI_META_LENGTH 224
#define AGENT_UI_MAX_ELEMENTS 48

typedef struct AgentUi AgentUi;

typedef enum {
  AgentUiLayoutText = 0,
  AgentUiLayoutList,
  AgentUiLayoutGrid,
  AgentUiLayoutCard,
  AgentUiLayoutProgress,
  AgentUiLayoutForm,
  AgentUiLayoutChoice,
  AgentUiLayoutModal,
} AgentUiLayout;

typedef struct {
  char meta[AGENT_UI_META_LENGTH];
  char input[20];
  char element_id[AGENT_UI_ID_LENGTH];
  char action[AGENT_UI_ACTION_LENGTH];
  char value[AGENT_UI_VALUE_LENGTH];
} AgentUiEvent;

typedef void (*AgentUiEventHandler)(const AgentUiEvent *event, void *context);
typedef void (*AgentUiDictationHandler)(void *context);

typedef struct {
  const char *kind;
  const char *id;
  const char *parent_id;
  const char *title;
  const char *subtitle;
  const char *value;
  const char *action;
  const char *meta;
  int32_t flags;
  int32_t index;
  uint32_t present;
} AgentUiElementSpec;

enum {
  AgentUiPresentKind = 1 << 0,
  AgentUiPresentId = 1 << 1,
  AgentUiPresentParentId = 1 << 2,
  AgentUiPresentTitle = 1 << 3,
  AgentUiPresentSubtitle = 1 << 4,
  AgentUiPresentValue = 1 << 5,
  AgentUiPresentAction = 1 << 6,
  AgentUiPresentMeta = 1 << 7,
  AgentUiPresentFlags = 1 << 8,
  AgentUiPresentIndex = 1 << 9,
  AgentUiPresentAll = (1 << 10) - 1,
};

AgentUi *agent_ui_create(AgentUiEventHandler event_handler, AgentUiDictationHandler dictation_handler,
                         void *context);
void agent_ui_destroy(AgentUi *ui);
Window *agent_ui_get_window(AgentUi *ui);
void agent_ui_show(AgentUi *ui, bool animated);

void agent_ui_begin(AgentUi *ui, const char *screen_id, const char *layout, const char *title,
                    const char *subtitle, const char *meta, int32_t flags);
bool agent_ui_add(AgentUi *ui, const AgentUiElementSpec *spec);
bool agent_ui_patch(AgentUi *ui, const AgentUiElementSpec *spec);
bool agent_ui_append(AgentUi *ui, const char *element_id, const char *value);
bool agent_ui_remove(AgentUi *ui, const char *element_id);
void agent_ui_end(AgentUi *ui);
void agent_ui_set_status(AgentUi *ui, const char *status, bool is_error, bool loading);

uint32_t agent_ui_error_revision(const AgentUi *ui);

const char *agent_ui_screen_id(const AgentUi *ui);
const char *agent_ui_layout_name(const AgentUi *ui);

// Reusable overlay menu: preserves the underlying screen and dismisses on an
// outside tap or Back. Item strings are copied; callers may use stack arrays.
typedef struct { const char *title; const char *action; } AgentUiMenuItem;
void agent_ui_open_menu(AgentUi *ui, const AgentUiMenuItem *items, uint8_t count);

void agent_ui_animate_request(AgentUi *ui);

// Immediate user interaction; passive redraws are coalesced to one per minute.
void agent_ui_note_input(AgentUi *ui);
void agent_ui_refresh_clock(AgentUi *ui);

void agent_ui_set_tap_animation(AgentUi *ui, bool enabled);

void agent_ui_set_codex_status(AgentUi *ui, int remaining, int active, const char *state);

void agent_ui_set_double_tap(AgentUi *ui, bool enabled);
