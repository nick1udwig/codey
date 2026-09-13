#include "internal.h"
#include "record_identity.h"
#include "../agent_protocol.h"
#include <stdlib.h>
#include <string.h>

#define TODO_COUNT 32
#define TODO_STORE 4300
#define TODO_MAGIC 0x544f4431
#define TODO_TEXT 180

typedef struct {
  uint32_t magic;
  uint32_t invocation;
  uint8_t state; // 0 empty, 1 undone, 2 archived
  char id[32];
  char text[TODO_TEXT];
} Todo;
typedef char TodoFitsPersistence[(sizeof(Todo) <= 256) ? 1 : -1];
typedef struct { AgentCapabilities *host; Todo items[TODO_COUNT]; } Todos;

static int prv_count(Todos *t, int state) {
  int count = 0;
  for (int i = 0; i < TODO_COUNT; ++i) { count += t->items[i].state == state; }
  return count;
}
static void prv_show(Todos *t, bool archive) {
  agent_capabilities_set_collection(t->host, false);
  AgentUi *ui = agent_capabilities_ui(t->host);
  agent_capabilities_set_active(t->host, archive ? "todo-archive" : "todos", true);
  agent_ui_begin(ui, archive ? "todo-archive" : "todos", "list", archive ? "Archive" : "Todos", "", "", 16);
  for (int i = 0; i < TODO_COUNT; ++i) {
    Todo *item = &t->items[i];
    if (item->state != (archive ? 2 : 1)) { continue; }
    char id[24], action[40];
    snprintf(id, sizeof(id), "todo-%d", i);
    snprintf(action, sizeof(action), "local.todo.toggle.%d", i);
    agent_capability_add_element(ui, "choice", id, "", "", item->text, action, "todo=true", archive ? 2 : 0);
  }
  if (!prv_count(t, archive ? 2 : 1)) {
    agent_capability_add_element(ui, "text", "todo-empty", "", "", archive ? "No archived items." : "No todos yet.", "", "", 0);
  }
  char title[40];
  snprintf(title, sizeof(title), "Archive (%d)", prv_count(t, 2));
  agent_capability_add_element(ui, "item", "todo-switch", archive ? "Back to todos" : title, "", "",
                               archive ? "local.todos" : "local.todo.archive", "", 0);
  agent_ui_end(ui);
}
static bool prv_save(Todos *t, int slot, Todo next) {
  if (persist_write_data(TODO_STORE + slot, &next, sizeof(next)) != (int)sizeof(next)) {
    agent_ui_set_status(agent_capabilities_ui(t->host), "Could not save todo. Item was not changed.", true, false);
    return false;
  }
  t->items[slot] = next;
  return true;
}
static bool prv_command(AgentCapabilities *host, const AgentCapabilityCommand *cmd, void *context) {
  (void)host;
  Todos *t = context;
  if (strcmp(cmd->command, "list") == 0) { prv_show(t, false); return true; }
  if (strcmp(cmd->command, "archive") == 0) { prv_show(t, true); return true; }
  if (strcmp(cmd->command, "add") != 0) { return false; }
  const char *text = cmd->value && cmd->value[0] ? cmd->value : cmd->title;
  if (!text || !text[0] || strlen(text) >= TODO_TEXT || (cmd->id && strlen(cmd->id) >= 32)) {
    agent_ui_set_status(agent_capabilities_ui(t->host), "Todo must contain 1-179 bytes of text.", true, false); return true;
  }
  int free_slot = -1;
  for (int i = 0; i < TODO_COUNT; ++i) {
    if (!t->items[i].state && free_slot < 0) { free_slot = i; }
    if (t->items[i].state && cmd->id && cmd->id[0] && !strcmp(t->items[i].id, cmd->id)) {
      if (strcmp(t->items[i].text, text)) agent_ui_set_status(agent_capabilities_ui(t->host), "Todo ID already exists.", true, false);
      return true;
    }
    if (t->items[i].state && cmd->invocation_id && t->items[i].invocation == cmd->invocation_id) { return true; }
  }
  if (free_slot < 0) {
    agent_ui_set_status(agent_capabilities_ui(t->host), "Todo storage is full (32 items including archive).", true, false); return true;
  }
  Todo item = { .magic = TODO_MAGIC, .invocation = cmd->invocation_id, .state = 1 };
  agent_protocol_copy(item.text, sizeof(item.text), text);
  agent_protocol_copy(item.id, sizeof(item.id), cmd->id);
  if (!item.id[0] && !record_identity(item.id, sizeof(item.id))) {
    agent_ui_set_status(agent_capabilities_ui(t->host), "Could not allocate todo ID. Try again.", true, false); return true;
  }
  if (prv_save(t, free_slot, item)) { prv_show(t, false); }
  return true;
}
static bool prv_event(AgentCapabilities *host, const AgentUiEvent *event, void *context) {
  (void)host;
  Todos *t = context;
  if (strcmp(event->action, "local.todos") == 0) { prv_show(t, false); return true; }
  if (strcmp(event->action, "local.todo.archive") == 0) { prv_show(t, true); return true; }
  const char *prefix = "local.todo.toggle.";
  if (strncmp(event->action, prefix, strlen(prefix)) != 0) { return false; }
  int32_t slot;
  if (!agent_protocol_parse_int32(event->action + strlen(prefix), NULL, &slot) || slot < 0 || slot >= TODO_COUNT || !t->items[slot].state) { return false; }
  bool archive = agent_capabilities_is_active(t->host, "todo-archive");
  if (!archive && !agent_capabilities_is_active(t->host, "todos")) { return false; }
  Todo next = t->items[slot]; next.state = archive ? 1 : 2;
  if (prv_save(t, slot, next)) { prv_show(t, archive); }
  return true;
}
static void prv_dashboard(AgentCapabilities *host, void *context, bool refresh) {
  (void)refresh;
  if (agent_capabilities_collection_is_notes(host)) return;
  char count[12]; snprintf(count, sizeof(count), "%d", prv_count(context, 1));
  agent_capability_patch_value(agent_capabilities_ui(host), "todos", count);
}
static void prv_destroy(void *context) { free(context); }
bool agent_todos_install(AgentCapabilities *host) {
  Todos *t = calloc(1, sizeof(*t));
  if (!t) { return false; }
  t->host = host;
  for (int i = 0; i < TODO_COUNT; ++i) {
    Todo item;
    if (persist_read_data(TODO_STORE + i, &item, sizeof(item)) == sizeof(item) && item.magic == TODO_MAGIC &&
        item.state <= 2 && (!item.state || item.id[0]) && memchr(item.text, 0, sizeof(item.text)) && memchr(item.id, 0, sizeof(item.id))) {
      t->items[i] = item;
    }
  }
  if (!agent_capabilities_register(host, "todo", (AgentCapabilityModule) {
    .command = prv_command, .event = prv_event, .dashboard = prv_dashboard, .destroy = prv_destroy }, t)) { free(t); return false; }
  return true;
}
