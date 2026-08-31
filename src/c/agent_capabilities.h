#pragma once

#include <pebble.h>

#include "agent_ui.h"

#define AGENT_CAPABILITY_NAME_LENGTH 20
#define AGENT_CAPABILITY_MAX_MODULES 8

typedef struct AgentCapabilities AgentCapabilities;

typedef struct {
  const char *type;
  const char *command;
  const char *id;
  const char *title;
  const char *subtitle;
  const char *value;
  const char *meta;
  int32_t flags;
} AgentCapabilityCommand;

typedef void (*AgentCapabilityEventHandler)(const char *type, const char *id, const char *action,
                                            const char *value, void *context);

typedef bool (*AgentCapabilityCommandHandler)(AgentCapabilities *capabilities,
                                              const AgentCapabilityCommand *command,
                                              void *module_context);
typedef bool (*AgentCapabilityUiEventHandler)(AgentCapabilities *capabilities,
                                              const AgentUiEvent *event,
                                              void *module_context);
typedef bool (*AgentCapabilityWakeupHandler)(AgentCapabilities *capabilities, WakeupId wakeup_id,
                                             int32_t cookie, void *module_context);
typedef void (*AgentCapabilityDestroyHandler)(void *module_context);

typedef struct {
  AgentCapabilityCommandHandler command;
  AgentCapabilityUiEventHandler event;
  AgentCapabilityWakeupHandler wakeup;
  AgentCapabilityDestroyHandler destroy;
} AgentCapabilityModule;

AgentCapabilities *agent_capabilities_create(AgentUi *ui, AgentCapabilityEventHandler event_handler,
                                              void *context);
void agent_capabilities_destroy(AgentCapabilities *capabilities);
bool agent_capabilities_register(AgentCapabilities *capabilities, const char *name,
                                 AgentCapabilityModule module, void *module_context);
bool agent_capabilities_handle_command(AgentCapabilities *capabilities,
                                       const AgentCapabilityCommand *command);
bool agent_capabilities_handle_ui_event(AgentCapabilities *capabilities, const AgentUiEvent *event);
bool agent_capabilities_has_active(const AgentCapabilities *capabilities);

// Module host API. New modules only need this header and a registration call.
AgentUi *agent_capabilities_ui(AgentCapabilities *capabilities);
void agent_capabilities_emit(AgentCapabilities *capabilities, const char *type, const char *id,
                             const char *action, const char *value);
void agent_capabilities_set_active(AgentCapabilities *capabilities, const char *name, bool active);

// Installs timer, stopwatch, and reminder. Weather is phone-side because it needs networking.
bool agent_capabilities_install_builtins(AgentCapabilities *capabilities);

