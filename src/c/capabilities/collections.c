#include "internal.h"
#include "../agent_protocol.h"
#include "../collection_preview.h"
#include <string.h>

// All collections share routing, cached previews and dashboard counts. Only
// service-specific actions and loading behavior belong in this descriptor.
typedef struct {
  int kind;
  const char *type, *screen, *loading, *title, *open, *list, *read, *page;
} Collection;
static const Collection collections[] = {
  {0, "todo", "todos", "todos", "To-dos", "local.todos", "local.todo.list", NULL, NULL},
  {1, "note", "notes", "notes-loading", "Notes", "local.notes", "local.note.list", "local.note.open", "local.note.page"},
  {2, "calendar", "calendar", "calendar", "Calendar", "local.events", "local.event.list", "local.event.open", "local.event.page"}
};

static void request(AgentCapabilities *host, const Collection *c, const char *id,
                    const char *action, const char *value) {
  agent_capabilities_set_collection_kind(host, c->kind);
  agent_capabilities_set_active(host, c->screen, true);
  bool list = !strcmp(action, "list");
  bool preview = list && strcmp(value, "next") && collection_preview_show(host, c->kind);
  bool loading = c->kind == 1 || (c->kind == 2 ? list :
                 strcmp(action, "complete") && strcmp(action, "restore"));
  if (!preview && loading) {
    AgentUi *ui = agent_capabilities_ui(host);
    agent_ui_begin(ui, c->loading, "list", c->title, "", "", 16);
    agent_capability_add_element(ui, "text", "loading", "", "", "Loading from phone…", "", "", 0);
    if (c->kind) agent_capability_add_element(ui, "item", "refresh", "Refresh", "", "", c->open, "", 0);
    agent_ui_end(ui);
  }
  agent_capabilities_emit(host, c->type, id, action, value);
}
static bool command(AgentCapabilities *host, const AgentCapabilityCommand *cmd, void *context) {
  const Collection *c = context;
  if (!strcmp(cmd->command, "list") || (!c->kind && !strcmp(cmd->command, "archive"))) {
    request(host, c, "", cmd->command, "0");
    return true;
  }
  if (c->kind == 1 && (!strcmp(cmd->command, "edit") || !strcmp(cmd->command, "append"))) {
    request(host, c, cmd->id, cmd->command, cmd->value);
    return true;
  }
  return false;
}
static bool event(AgentCapabilities *host, const AgentUiEvent *e, void *context) {
  const Collection *c = context;
  if (!strcmp(e->action, c->open) || (c->kind == 2 && !strcmp(e->action, "local.calendar"))) {
    request(host, c, "", "list", "0");
  } else if (!strcmp(e->action, c->list)) {
    request(host, c, e->element_id, "list", e->value);
  } else if (c->read && !strcmp(e->action, c->read)) {
    request(host, c, e->element_id, "read", c->kind == 1 ? "0" : e->value);
  } else if (c->page && !strcmp(e->action, c->page)) {
    char id[32];
    if (c->kind == 1) agent_protocol_meta_get(e->meta, "note", id, sizeof(id));
    request(host, c, c->kind == 1 ? id : e->element_id, "read", e->value);
  } else if (!c->kind && !strcmp(e->action, "local.todo.archive")) {
    request(host, c, "", "archive", "0");
  } else if (!c->kind && (!strcmp(e->action, "local.todo.complete") || !strcmp(e->action, "local.todo.restore"))) {
    request(host, c, e->element_id, !strcmp(e->action, "local.todo.complete") ? "complete" : "restore", "");
  } else return false;
  return true;
}
static void dashboard(AgentCapabilities *host, void *context, bool refresh) {
  (void)refresh;
  const Collection *c = context;
  if (agent_capabilities_collection_kind(host) != c->kind) return;
  char count[16];
  collection_preview_count(c->kind, count, sizeof(count));
  agent_capability_patch_value(agent_capabilities_ui(host), "todos", count);
}
bool agent_collections_install(AgentCapabilities *host) {
  for (unsigned i = 0; i < sizeof(collections) / sizeof(collections[0]); i++) {
    if (!agent_capabilities_register(host, collections[i].type,
        (AgentCapabilityModule){.command=command, .event=event, .dashboard=dashboard},
        (void *)&collections[i])) return false;
  }
  return true;
}
