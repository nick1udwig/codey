#include "../agent_protocol.h"
#include "internal.h"
#include "record_identity.h"
#include <stdlib.h>
#include <string.h>

#define NOTE_COUNT 24
#define NOTE_STORE 4400
#define NOTE_MAGIC 0x4e4f5431
#define NOTE_TEXT 180

typedef struct {
  uint32_t magic, invocation;
  char id[32], text[NOTE_TEXT];
} Note;
typedef char NoteFitsPersistence[(sizeof(Note) <= 256) ? 1 : -1];
typedef struct {
  AgentCapabilities *host;
  Note items[NOTE_COUNT];
} Notes;

static void show(Notes *s) {
  agent_capabilities_set_collection(s->host, true);
  agent_capabilities_set_active(s->host, "notes", true);
  AgentUi *ui = agent_capabilities_ui(s->host);
  agent_ui_begin(ui, "notes", "list", "Notes", "", "", 16);
  int count = 0;
  for (int i = 0; i < NOTE_COUNT; ++i) {
    Note *n = &s->items[i];
    if (!n->id[0])
      continue;
    agent_capability_add_element(ui, "item", n->id, n->text, "", "",
                                 "local.note.open", "", 0);
    ++count;
  }
  if (!count)
    agent_capability_add_element(ui, "text", "note-empty", "", "",
                                 "No notes yet. Say: make a note ...", "", "",
                                 0);
  agent_ui_end(ui);
}
static void detail(Notes *s, Note *n) {
  AgentUi *ui = agent_capabilities_ui(s->host);
  agent_capabilities_set_collection(s->host, true);
  agent_capabilities_set_active(s->host, "note-detail", true);
  agent_ui_begin(ui, "note-detail", "list", "Note", "", "", 16);
  agent_capability_add_element(ui, "text", "note-body", "", "", n->text, "", "",
                               0);
  agent_capability_add_element(ui, "item", n->id, "Edit note", "Dictate replacement text", "", "local.note.edit", "", 0);
  agent_capability_add_element(ui, "item", "notes-back", "Back to notes", "",
                               "", "local.notes", "", 0);
  agent_ui_end(ui);
}
static void error(Notes *s, const char *message) {
  agent_ui_set_status(agent_capabilities_ui(s->host), message, true, false);
}
static bool command(AgentCapabilities *host, const AgentCapabilityCommand *c,
                    void *context) {
  (void)host;
  Notes *s = context;
  if (!strcmp(c->command, "list")) {
    show(s);
    return true;
  }
  bool edit = !strcmp(c->command, "edit");
  if (!edit && strcmp(c->command, "add"))
    return false;
  const char *text = c->value;
  if (!text || !text[0] || strlen(text) >= NOTE_TEXT ||
      (c->id && strlen(c->id) >= 32)) {
    error(s, "Note must contain 1-179 bytes of text.");
    return true;
  }
  char match_text[NOTE_TEXT];
  agent_protocol_meta_get(c->meta, "match", match_text, sizeof(match_text));
  const char *target = match_text[0] ? match_text : c->title;
  int slot = -1, matches = 0;
  for (int i = 0; i < NOTE_COUNT; ++i) {
    Note *n = &s->items[i];
    if (n->id[0] && c->invocation_id && n->invocation == c->invocation_id)
      return true;
    if (edit) {
      bool match = c->id && c->id[0]
                       ? !strcmp(c->id, n->id)
                       : target && target[0] && !strcmp(target, n->text);
      if (n->id[0] && match) {
        slot = i;
        ++matches;
      }
    } else {
      if (!n->id[0] && slot < 0)
        slot = i;
      if (n->id[0] && c->id && c->id[0] && !strcmp(c->id, n->id)) {
        if (strcmp(text, n->text))
          error(s, "Note ID already exists. Use edit.");
        return true;
      }
    }
  }
  if (edit && matches != 1) {
    error(s, matches
                 ? "Several notes match. Edit using a note ID."
                 : "Note not found. Say: edit a note OLD TEXT to NEW TEXT.");
    return true;
  }
  if (slot < 0) {
    error(s, "Note storage is full (24 notes).");
    return true;
  }
  Note next = edit ? s->items[slot] : (Note){.magic = NOTE_MAGIC};
  if (!edit) {
    if (c->id && c->id[0])
      agent_protocol_copy(next.id, sizeof(next.id), c->id);
    else if (!record_identity(next.id, sizeof(next.id))) {
      error(s, "Could not allocate note ID. Try again.");
      return true;
    }
  }
  next.invocation = c->invocation_id;
  agent_protocol_copy(next.text, sizeof(next.text), text);
  if (persist_write_data(NOTE_STORE + slot, &next, sizeof(next)) !=
      sizeof(next)) {
    error(s, "Could not save note. Note was not changed.");
    return true;
  }
  s->items[slot] = next;
  detail(s, &s->items[slot]);
  return true;
}
static bool event(AgentCapabilities *host, const AgentUiEvent *e,
                  void *context) {
  (void)host;
  Notes *s = context;
  if (!strcmp(e->action, "local.notes")) {
    show(s);
    return true;
  }
  if (strcmp(e->action, "local.note.open"))
    return false;
  for (int i = 0; i < NOTE_COUNT; ++i)
    if (s->items[i].id[0] && !strcmp(s->items[i].id, e->element_id)) {
      detail(s, &s->items[i]);
      return true;
    }
  error(s, "Note not found.");
  return true;
}
static void dashboard(AgentCapabilities *host, void *context, bool refresh) {
  (void)refresh;
  Notes *s = context;
  if (!agent_capabilities_collection_is_notes(host))
    return;
  int count = 0;
  for (int i = 0; i < NOTE_COUNT; ++i)
    count += s->items[i].id[0] != 0;
  char value[12];
  snprintf(value, sizeof(value), "%d", count);
  agent_capability_patch_value(agent_capabilities_ui(host), "todos", value);
}
static void destroy(void *context) { free(context); }
bool agent_notes_install(AgentCapabilities *host) {
  Notes *s = calloc(1, sizeof(*s));
  if (!s)
    return false;
  s->host = host;
  for (int i = 0; i < NOTE_COUNT; ++i) {
    Note n;
    if (persist_read_data(NOTE_STORE + i, &n, sizeof(n)) == sizeof(n) &&
        n.magic == NOTE_MAGIC && memchr(n.id, 0, sizeof(n.id)) &&
        memchr(n.text, 0, sizeof(n.text)))
      s->items[i] = n;
  }
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
