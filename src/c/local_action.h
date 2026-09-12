#pragma once
#include "agent_capabilities.h"
#include "agent_protocol.h"
#include <string.h>

// A bounded declaration, never executable code. Only explicit local creations.
static inline bool local_action_build(const AgentUiEvent *event, AgentCapabilityCommand *out,
                                     char *type, char *task, char *args, size_t args_size) {
  if (!agent_protocol_meta_get(event->meta, "capability", type, 20) ||
      !agent_protocol_meta_get(event->meta, "task", task, 72) || !task[0]) { return false; }
  bool timer = strcmp(type, "timer") == 0;
  bool reminder = strcmp(type, "reminder") == 0 || strcmp(type, "alarm") == 0;
  if (!timer && !reminder) { return false; }
  char duration[24]; int32_t seconds;
  if (!agent_protocol_meta_get(event->meta, "seconds", duration, sizeof(duration))) { return false; }
  const char *value = strcmp(duration, "$value") == 0 ? event->value : duration;
  if (!agent_protocol_parse_int32(value, NULL, &seconds) || seconds < 1 || seconds > 604800) { return false; }
  snprintf(args, args_size, "%s=%lds", timer ? "duration" : "in", (long)seconds);
  *out = (AgentCapabilityCommand) { .type = type, .command = timer ? "start" : "schedule",
    .title = task, .meta = args };
  return true;
}
