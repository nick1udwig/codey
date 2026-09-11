#pragma once

#include "../agent_capabilities.h"

#define AGENT_CAP_MAX(a, b) ((a) > (b) ? (a) : (b))
#define AGENT_CAP_MIN(a, b) ((a) < (b) ? (a) : (b))

bool agent_schedules_install(AgentCapabilities *capabilities);
bool agent_stopwatch_install(AgentCapabilities *capabilities);

int32_t agent_capability_parse_duration(const char *value, int32_t fallback);
void agent_capability_format_duration(char *dest, size_t dest_size, int32_t seconds, bool hours_always);
void agent_capability_add_element(AgentUi *ui, const char *kind, const char *id, const char *title,
                                  const char *subtitle, const char *value, const char *action,
                                  const char *meta, int32_t flags);
void agent_capability_patch_value(AgentUi *ui, const char *id, const char *value);
