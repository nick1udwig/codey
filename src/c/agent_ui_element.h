#pragma once
#include "agent_ui.h"

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
  char id[AGENT_UI_ID_LENGTH];
  char title[AGENT_UI_TITLE_LENGTH];
  char subtitle[AGENT_UI_SUBTITLE_LENGTH];
  char value[AGENT_UI_VALUE_LENGTH];
  char action[AGENT_UI_ACTION_LENGTH];
  char meta[AGENT_UI_META_LENGTH];
  int32_t flags;
  GRect frame;
  uint16_t text_offset;
} AgentUiElement;

bool agent_ui_element_apply(AgentUiElement *element, const AgentUiElementSpec *spec, bool patch);
