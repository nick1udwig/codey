#include "agent_ui_element.h"
#include "agent_protocol.h"
#include <string.h>

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

bool agent_ui_element_apply(AgentUiElement *element, const AgentUiElementSpec *spec, bool patch) {
  bool changed = false;
  uint32_t present = patch ? spec->present : AgentUiPresentAll;
  if (present & AgentUiPresentKind) {
    AgentUiElementKind kind = prv_element_kind(spec->kind);
    changed |= element->kind != kind;
    element->kind = kind;
  }
  if (present & AgentUiPresentId) { changed |= agent_protocol_update(element->id, sizeof(element->id), spec->id); }
  if (present & AgentUiPresentTitle) { changed |= agent_protocol_update(element->title, sizeof(element->title), spec->title); }
  if (present & AgentUiPresentSubtitle) {
    changed |= agent_protocol_update(element->subtitle, sizeof(element->subtitle), spec->subtitle);
  }
  if (present & AgentUiPresentValue) { changed |= agent_protocol_update(element->value, sizeof(element->value), spec->value); }
  if (present & AgentUiPresentAction) {
    changed |= agent_protocol_update(element->action, sizeof(element->action), spec->action);
  }
  if (present & AgentUiPresentMeta) { changed |= agent_protocol_update(element->meta, sizeof(element->meta), spec->meta); }
  if (present & AgentUiPresentFlags) { changed |= element->flags != spec->flags; element->flags = spec->flags; }
  return changed;
}
