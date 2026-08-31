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
};

static AgentCapabilities *s_wakeup_capabilities;

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
  return capabilities;
}

void agent_capabilities_destroy(AgentCapabilities *capabilities) {
  uint8_t index;
  if (!capabilities) { return; }
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
  if (!capabilities || !command || !command->type) { return false; }
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
  return agent_timer_install(capabilities) && agent_stopwatch_install(capabilities) &&
         agent_reminder_install(capabilities);
}

int32_t agent_capability_parse_duration(const char *value, int32_t fallback) {
  char *end;
  long parsed;
  int32_t multiplier = 1;
  if (!value || !value[0]) { return fallback; }
  parsed = strtol(value, &end, 10);
  if (end == value || parsed < 0) { return fallback; }
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
