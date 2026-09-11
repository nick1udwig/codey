#include "agent_capabilities.h"

#include "agent_protocol.h"
#include "capabilities/internal.h"

#include <stdlib.h>
#include <string.h>

#define AGENT_WAKEUP_SCHEMA_KEY 4099
#define AGENT_WAKEUP_SCHEMA_VERSION 1

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
  AppTimer *tick_timer;
  uint32_t navigation_revision;
  uint32_t notification_revision;
};

static AgentCapabilities *s_wakeup_capabilities;

static void prv_tick(void *context) {
  AgentCapabilities *capabilities = context;
  capabilities->tick_timer = NULL;
  for (uint8_t i = 0; i < capabilities->module_count; ++i) {
    RegisteredModule *module = &capabilities->modules[i];
    if (module->module.tick) { module->module.tick(module->context); }
  }
  agent_capabilities_refresh_dashboard(capabilities);
  capabilities->tick_timer = app_timer_register(1000, prv_tick, capabilities);
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
  if (!persist_exists(AGENT_WAKEUP_SCHEMA_KEY) ||
      persist_read_int(AGENT_WAKEUP_SCHEMA_KEY) != AGENT_WAKEUP_SCHEMA_VERSION) {
    // Wakeup IDs can outlive a development/app upgrade. Clear the app's old
    // registrations once; each persisted module reschedules its valid state.
    wakeup_cancel_all();
    persist_write_int(AGENT_WAKEUP_SCHEMA_KEY, AGENT_WAKEUP_SCHEMA_VERSION);
  }
  s_wakeup_capabilities = capabilities;
  wakeup_service_subscribe(prv_wakeup_handler);
  if (!agent_capabilities_install_builtins(capabilities)) {
    agent_capabilities_destroy(capabilities);
    return NULL;
  }
  agent_protocol_copy(capabilities->connection, sizeof(capabilities->connection), "Connecting to phone");
  agent_capabilities_show_dashboard(capabilities);
  capabilities->tick_timer = app_timer_register(1000, prv_tick, capabilities);
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
  agent_ui_begin(capabilities->ui, "dashboard", "list", "Agent", "", "", 16);
  for (uint8_t i = 0; i < capabilities->module_count; ++i) {
    RegisteredModule *module = &capabilities->modules[i];
    if (module->module.dashboard) {
      module->module.dashboard(capabilities, module->context, false);
    }
  }
  agent_capability_add_element(capabilities->ui, "item", "dictate", "Ask Agent",
                               "Hold Select to dictate", "", "local.dictate", "", 0);
  agent_capability_add_element(capabilities->ui, "text", "connection", "", "",
                               capabilities->connection, "", "", 0);
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
  agent_capabilities_show_dashboard(capabilities);
  capabilities->navigation_revision = revision;
}

void agent_capabilities_show_notifications(AgentCapabilities *capabilities) {
  if (!capabilities) { return; }
  // A due alert changes focus, but must not cancel an outstanding user command.
  capabilities->notification_revision += 1;
  agent_capabilities_rebuild_dashboard(capabilities);
}

void agent_capabilities_refresh_dashboard(AgentCapabilities *capabilities) {
  if (!agent_capabilities_is_active(capabilities, "dashboard")) { return; }
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
  return agent_schedules_install(capabilities) && agent_stopwatch_install(capabilities);
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
