#include "../agent_protocol.h"
#include "internal.h"
#include "../collection_preview.h"
#include <stdlib.h>
#include <string.h>

typedef struct { AgentCapabilities *host; int count; } Notes;
static void request(Notes *s, const char *id, const char *action,
                    const char *value) {
  agent_capabilities_set_collection(s->host, true);
  agent_capabilities_set_active(s->host, "notes", true);
  AgentUi *ui = agent_capabilities_ui(s->host);
  bool preview=!strcmp(action,"list") && strcmp(value,"next") && collection_preview_show(s->host,true);
  if(!preview) {
  agent_ui_begin(ui, "notes-loading", "list", "Notes", "", "", 16);
  agent_capability_add_element(ui, "text", "loading", "", "",
                               "Loading from phone…", "", "", 0);
  agent_capability_add_element(ui, "item", "retry", "Reload notes", "", "",
                               "local.notes", "", 0);
  agent_ui_end(ui);
  }
  agent_capabilities_emit(s->host, "note", id, action, value);
}
static bool command(AgentCapabilities *host, const AgentCapabilityCommand *c,
                    void *context) {
  (void)host;
  Notes *s = context;
  if (!strcmp(c->command, "list")) {
    request(s, "", "list", "0");
    return true;
  }
  if (!strcmp(c->command, "edit") || !strcmp(c->command, "append")) {
    request(s, c->id, c->command, c->value);
    return true;
  }
  if (!strcmp(c->command, "count")) {
    int32_t count = 0;
    agent_protocol_parse_int32(c->value, NULL, &count);
    s->count = count;
    agent_capabilities_refresh_dashboard(s->host);
    return true;
  }
  return false;
}
static bool event(AgentCapabilities *host, const AgentUiEvent *e,
                  void *context) {
  (void)host;
  Notes *s = context;
  if (!strcmp(e->action, "local.notes")) {
    request(s, "", "list", "0");
    return true;
  }
  if (!strcmp(e->action, "local.note.list")) {
    request(s, "", "list", e->value);
    return true;
  }
  if (!strcmp(e->action, "local.note.open")) {
    request(s, e->element_id, "read", "0");
    return true;
  }
  if (!strcmp(e->action, "local.note.page")) {
    char id[32];
    agent_protocol_meta_get(e->meta, "note", id, sizeof(id));
    request(s, id, "read", e->value);
    return true;
  }
  return false;
}
static void dashboard(AgentCapabilities *host, void *context, bool refresh) {
  (void)refresh;
  Notes *s = context;
  if (!agent_capabilities_collection_is_notes(host))
    return;
  char count[12];
  if (s->count < 0)
    agent_protocol_copy(count, sizeof(count), "-");
  else
    snprintf(count, sizeof(count), "%d", s->count);
  agent_capability_patch_value(agent_capabilities_ui(host), "todos", count);
}
static void destroy(void *context) { free(context); }
bool agent_notes_install(AgentCapabilities *host) {
  Notes *s = calloc(1, sizeof(*s));
  if (!s)
    return false;
  s->host = host;
  s->count = -1;
  if (!agent_capabilities_register(
          host, "note",
          (AgentCapabilityModule){.command = command,
                                  .event = event,
                                  .dashboard = dashboard,
                                  .destroy = destroy},
          s)) {
    free(s);
    return false;
  }
  return true;
}
