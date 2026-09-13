#include "agent_capabilities.h"

#include "agent_protocol.h"
#include "capabilities/internal.h"

#include <stdlib.h>
#include <string.h>

#define COLLECTION_PREFERENCE_KEY 4399

typedef struct {
  char name[AGENT_CAPABILITY_NAME_LENGTH];
  AgentCapabilityModule module;
  void *context;
} RegisteredModule;

struct AgentCapabilities {
  AgentUi *ui;
  AgentCapabilityEventHandler event_handler;
  void *context;
  RegisteredModule modules[AGENT_CAPABILITY_MAX_MODULES];
  uint8_t module_count;
  char active_name[AGENT_CAPABILITY_NAME_LENGTH];
  char connection[72];
  char weather_temperature[12], weather_range[32], weather_meta[40];
  uint16_t weather_ticks;
  bool collection_notes;
  AppTimer *tick_timer;
  uint32_t navigation_revision;
  uint32_t notification_revision;
};

static AgentCapabilities *s_wakeup_capabilities;
static void prv_show_notifications(AgentCapabilities *capabilities);

static void prv_tick(void *context) {
  AgentCapabilities *capabilities = context;
  capabilities->tick_timer = NULL;
  for (uint8_t i = 0; i < capabilities->module_count; ++i) {
    RegisteredModule *module = &capabilities->modules[i];
    if (module->module.tick) { module->module.tick(module->context); }
  }
  agent_capabilities_refresh_dashboard(capabilities);
  agent_ui_refresh_clock(capabilities->ui);
  agent_capabilities_emit(capabilities,"status","","refresh","");
  if (++capabilities->weather_ticks >= 15) {
    capabilities->weather_ticks = 0;
    agent_capabilities_emit(capabilities, "weather", "", "refresh", "");
  }
  capabilities->tick_timer = app_timer_register(60000, prv_tick, capabilities);
}

void agent_capabilities_refresh_now(AgentCapabilities *capabilities) {
  for (uint8_t i=0;i<capabilities->module_count;++i) {
    RegisteredModule *module=&capabilities->modules[i];
    if(module->module.tick)module->module.tick(module->context);
  }
  agent_capabilities_refresh_dashboard(capabilities);
  agent_ui_refresh_clock(capabilities->ui);
}

static void prv_wakeup_handler(WakeupId wakeup_id, int32_t cookie) {
  uint8_t index;
  if (!s_wakeup_capabilities) { return; }
  for (index = 0; index < s_wakeup_capabilities->module_count; index += 1) {
    RegisteredModule *registered = &s_wakeup_capabilities->modules[index];
    if (registered->module.wakeup &&
        registered->module.wakeup(s_wakeup_capabilities, wakeup_id, cookie, registered->context)) {
      return;
    }
  }
}

AgentCapabilities *agent_capabilities_create(AgentUi *ui, AgentCapabilityEventHandler event_handler,
                                              void *context) {
  AgentCapabilities *capabilities = calloc(1, sizeof(AgentCapabilities));
  if (!capabilities) { return NULL; }
  capabilities->ui = ui;
  capabilities->event_handler = event_handler;
  capabilities->context = context;
  s_wakeup_capabilities = capabilities;
  wakeup_service_subscribe(prv_wakeup_handler);
  capabilities->collection_notes = persist_read_int(COLLECTION_PREFERENCE_KEY) == 1;
  if (!agent_capabilities_install_builtins(capabilities)) {
    agent_capabilities_destroy(capabilities);
    return NULL;
  }
  agent_protocol_copy(capabilities->connection, sizeof(capabilities->connection), "Connecting to phone");
  agent_capabilities_show_dashboard(capabilities);
  capabilities->tick_timer = app_timer_register(60000, prv_tick, capabilities);
  return capabilities;
}

void agent_capabilities_destroy(AgentCapabilities *capabilities) {
  uint8_t index;
  if (!capabilities) { return; }
  if (capabilities->tick_timer) { app_timer_cancel(capabilities->tick_timer); }
  for (index = 0; index < capabilities->module_count; index += 1) {
    RegisteredModule *registered = &capabilities->modules[index];
    if (registered->module.destroy) {
      registered->module.destroy(registered->context);
    }
  }
  if (s_wakeup_capabilities == capabilities) {
    s_wakeup_capabilities = NULL;
  }
  free(capabilities);
}

bool agent_capabilities_register(AgentCapabilities *capabilities, const char *name,
                                 AgentCapabilityModule module, void *module_context) {
  uint8_t index;
  RegisteredModule *registered;
  if (!capabilities || !name || !name[0] || !module.command ||
      capabilities->module_count >= AGENT_CAPABILITY_MAX_MODULES) {
    return false;
  }
  for (index = 0; index < capabilities->module_count; index += 1) {
    if (strcmp(capabilities->modules[index].name, name) == 0) { return false; }
  }
  registered = &capabilities->modules[capabilities->module_count++];
  agent_protocol_copy(registered->name, sizeof(registered->name), name);
  registered->module = module;
  registered->context = module_context;
  return true;
}

bool agent_capabilities_handle_command(AgentCapabilities *capabilities,
                                       const AgentCapabilityCommand *command) {
  uint8_t index;
  if (!capabilities || !command || !command->type || !command->command) { return false; }
  for (index = 0; index < capabilities->module_count; index += 1) {
    RegisteredModule *registered = &capabilities->modules[index];
    if (strcmp(registered->name, command->type) == 0) {
      return registered->module.command(capabilities, command, registered->context);
    }
  }
  return false;
}

bool agent_capabilities_handle_ui_event(AgentCapabilities *capabilities, const AgentUiEvent *event) {
  uint8_t index;
  if (!capabilities || !event) { return false; }
  if (strcmp(event->action, "local.home") == 0 ||
      (strcmp(event->input, "back") == 0 &&
       !agent_capabilities_is_active(capabilities, "dashboard"))) {
    agent_capabilities_show_dashboard(capabilities);
    return true;
  }
  if (strcmp(event->action, "local.dashboard.notifications") == 0) {
    capabilities->navigation_revision += 1;
    prv_show_notifications(capabilities);
    AgentCapabilityCommand refresh = { .type = "job", .command = "refresh", .id = "" };
    agent_capabilities_handle_command(capabilities, &refresh);
    return true;
  }
  if (strcmp(event->action, "local.calendar") == 0) {
    capabilities->navigation_revision += 1;
    agent_capabilities_set_active(capabilities, "calendar", true);
    agent_ui_begin(capabilities->ui, "calendar", "card",
                   "Calendar", "", "", 16);
    agent_capability_add_element(capabilities->ui, "text", "placeholder", "", "",
                                 "Calendar view coming soon.", "", "", 0);
    agent_capability_add_element(capabilities->ui, "item", "home", "Back to dashboard", "", "", "local.home", "", 0);
    agent_ui_end(capabilities->ui);
    return true;
  }
  if (strcmp(event->action, "local.notes") == 0 || strncmp(event->action, "local.note.", 11) == 0 || strcmp(event->action, "local.todos") == 0 || strncmp(event->action, "local.todo.", 11) == 0) { capabilities->navigation_revision += 1; }
  for (index = 0; index < capabilities->module_count; index += 1) {
    RegisteredModule *registered = &capabilities->modules[index];
    if (registered->module.event &&
        registered->module.event(capabilities, event, registered->context)) {
      return true;
    }
  }
  return false;
}

bool agent_capabilities_has_active(const AgentCapabilities *capabilities) {
  return capabilities && capabilities->active_name[0];
}

bool agent_capabilities_is_active(const AgentCapabilities *capabilities, const char *name) {
  return capabilities && name && strcmp(capabilities->active_name, name) == 0;
}

void agent_capabilities_show_dashboard(AgentCapabilities *capabilities) {
  if (!capabilities) { return; }
  capabilities->navigation_revision += 1;
  agent_capabilities_set_active(capabilities, "dashboard", true);
  agent_ui_begin(capabilities->ui, "dashboard", "list", "", "", "", 0);
  agent_capability_add_element(capabilities->ui, "item", "calendar", "Calendar", "", "", "local.calendar", "", 0);
  agent_capability_add_element(capabilities->ui, "item", "dashboard-summary", "Notifications",
                               "", "", "local.dashboard.notifications", "", 0);
  agent_capability_add_element(capabilities->ui, "item", "dictate", "Talk to Agent",
                               "Hold Select", "", "local.dictate", "", 0);
  agent_capability_add_element(capabilities->ui, "item", "weather", "Weather", capabilities->weather_range, capabilities->weather_temperature, "local.weather", capabilities->weather_meta, 0);
  agent_capability_add_element(capabilities->ui, "item", "todos", capabilities->collection_notes ? "Notes" : "Todos", "", "", capabilities->collection_notes ? "local.notes" : "local.todos", "", 0);
  for (uint8_t i = 0; i < capabilities->module_count; ++i) {
    RegisteredModule *module = &capabilities->modules[i];
    if (module->module.dashboard) {
      module->module.dashboard(capabilities, module->context, false);
    }
  }
  agent_capability_add_element(capabilities->ui, "text", "connection", "", "",
                               capabilities->connection, "", "", 0);
  agent_ui_end(capabilities->ui);
}

static void prv_show_notifications(AgentCapabilities *capabilities) {
  agent_capabilities_set_active(capabilities, "notifications", true);
  agent_ui_begin(capabilities->ui, "notifications", "list", "Notifications", "", "", 16);
  for (uint8_t i = 0; i < capabilities->module_count; ++i) {
    RegisteredModule *module = &capabilities->modules[i];
    if (module->module.dashboard) { module->module.dashboard(capabilities, module->context, false); }
  }
  agent_ui_end(capabilities->ui);
}

uint32_t agent_capabilities_navigation_revision(const AgentCapabilities *capabilities) {
  return capabilities ? capabilities->navigation_revision : 0;
}

uint32_t agent_capabilities_notification_revision(const AgentCapabilities *capabilities) {
  return capabilities ? capabilities->notification_revision : 0;
}

void agent_capabilities_rebuild_dashboard(AgentCapabilities *capabilities) {
  if (!capabilities) { return; }
  uint32_t revision = capabilities->navigation_revision;
  if (agent_capabilities_is_active(capabilities, "notifications")) { prv_show_notifications(capabilities); }
  else { agent_capabilities_show_dashboard(capabilities); }
  capabilities->navigation_revision = revision;
}

void agent_capabilities_show_notifications(AgentCapabilities *capabilities) {
  if (!capabilities) { return; }
  // A due alert changes focus, but must not cancel an outstanding user command.
  capabilities->notification_revision += 1;
  prv_show_notifications(capabilities);
}

void agent_capabilities_refresh_dashboard(AgentCapabilities *capabilities) {
  if (!agent_capabilities_is_active(capabilities, "dashboard") &&
      !agent_capabilities_is_active(capabilities, "notifications")) { return; }
  agent_capability_patch_value(capabilities->ui, "connection", capabilities->connection);
  for (uint8_t i = 0; i < capabilities->module_count; ++i) {
    RegisteredModule *module = &capabilities->modules[i];
    if (module->module.dashboard) {
      module->module.dashboard(capabilities, module->context, true);
    }
  }
}

void agent_capabilities_set_connection(AgentCapabilities *capabilities, const char *status) {
  if (!capabilities) { return; }
  agent_protocol_copy(capabilities->connection, sizeof(capabilities->connection), status);
  if (agent_capabilities_is_active(capabilities, "dashboard")) {
    agent_capability_patch_value(capabilities->ui, "connection", capabilities->connection);
  }
}

AgentUi *agent_capabilities_ui(AgentCapabilities *capabilities) {
  return capabilities ? capabilities->ui : NULL;
}

void agent_capabilities_emit(AgentCapabilities *capabilities, const char *type, const char *id,
                             const char *action, const char *value) {
  if (capabilities && capabilities->event_handler) {
    capabilities->event_handler(type, id, action, value, capabilities->context);
  }
}

void agent_capabilities_set_active(AgentCapabilities *capabilities, const char *name, bool active) {
  if (!capabilities) { return; }
  if (active) {
    agent_protocol_copy(capabilities->active_name, sizeof(capabilities->active_name), name);
  } else if (!name || strcmp(capabilities->active_name, name) == 0) {
    capabilities->active_name[0] = '\0';
  }
}

bool agent_capabilities_install_builtins(AgentCapabilities *capabilities) {
  return agent_jobs_install(capabilities) && agent_schedules_install(capabilities) && agent_stopwatch_install(capabilities) && agent_todos_install(capabilities) && agent_notes_install(capabilities);
}

int32_t agent_capability_parse_duration(const char *value, int32_t fallback) {
  const char *end;
  int32_t parsed;
  int32_t multiplier = 1;
  if (!value || !value[0]) { return fallback; }
  if (!agent_protocol_parse_int32(value, &end, &parsed) || parsed < 0) { return fallback; }
  if (*end == 's' && !end[1]) { multiplier = 1; }
  else if (*end == 'm' && !end[1]) { multiplier = 60; }
  else if (*end == 'h' && !end[1]) { multiplier = 3600; }
  else if (*end == 'd' && !end[1]) { multiplier = 86400; }
  else if (*end) { return fallback; }
  if (parsed > INT32_MAX / multiplier) { return fallback; }
  return (int32_t)parsed * multiplier;
}

void agent_capability_format_duration(char *dest, size_t dest_size, int32_t seconds, bool hours_always) {
  int32_t hours;
  int32_t minutes;
  seconds = seconds < 0 ? 0 : seconds;
  hours = seconds / 3600;
  minutes = (seconds % 3600) / 60;
  if (hours || hours_always) {
    snprintf(dest, dest_size, "%ld:%02ld:%02ld", (long)hours, (long)minutes, (long)(seconds % 60));
  } else {
    snprintf(dest, dest_size, "%02ld:%02ld", (long)minutes, (long)(seconds % 60));
  }
}

void agent_capability_add_element(AgentUi *ui, const char *kind, const char *id, const char *title,
                                  const char *subtitle, const char *value, const char *action,
                                  const char *meta, int32_t flags) {
  agent_ui_add(ui, &(AgentUiElementSpec) {
    .kind = kind,
    .id = id,
    .parent_id = "",
    .title = title,
    .subtitle = subtitle,
    .value = value,
    .action = action,
    .meta = meta,
    .flags = flags,
    .index = 0,
    .present = AgentUiPresentAll,
  });
}

void agent_capability_patch_value(AgentUi *ui, const char *id, const char *value) {
  agent_ui_patch(ui, &(AgentUiElementSpec) {
    .id = id,
    .value = value,
    .present = AgentUiPresentId | AgentUiPresentValue,
  });
}

void agent_capabilities_set_weather(AgentCapabilities *c, const char *temperature, const char *range, const char *meta) {
  if (!c) { return; }
  agent_protocol_copy(c->weather_temperature, sizeof(c->weather_temperature), temperature);
  agent_protocol_copy(c->weather_range, sizeof(c->weather_range), range);
  agent_protocol_copy(c->weather_meta, sizeof(c->weather_meta), meta);
  if (strcmp(agent_ui_screen_id(c->ui), "dashboard") == 0) {
    AgentUiElementSpec spec = { .id = "weather", .value = c->weather_temperature,
      .subtitle = c->weather_range, .meta = c->weather_meta,
      .present = AgentUiPresentValue | AgentUiPresentSubtitle | AgentUiPresentMeta };
    agent_ui_patch(c->ui, &spec);
  }
}

void agent_capabilities_set_collection(AgentCapabilities *capabilities, bool notes) {
  if (capabilities->collection_notes == notes) return;
  if (persist_write_int(COLLECTION_PREFERENCE_KEY, notes ? 1 : 0) != sizeof(int32_t)) {
    agent_ui_set_status(capabilities->ui, "Could not save dashboard preference.", false, false);
    return;
  }
  capabilities->collection_notes = notes;
}
bool agent_capabilities_collection_is_notes(const AgentCapabilities *capabilities) {
  return capabilities->collection_notes;
}
