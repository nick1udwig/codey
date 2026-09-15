#pragma once
#include "agent_capabilities.h"
// flags: completed=1, next page=2, cached phone page=4, partial=8, first active page=16.
void collection_preview_receive(AgentCapabilities *host, int kind, const char *titles, int flags, const char *status, const char *states);
void collection_preview_receive_timeline(AgentCapabilities *host, const char *titles, int flags, const char *status, const char *states, const char *metadata);
bool collection_preview_show(AgentCapabilities *host, int kind);

void collection_preview_count(int kind, char *out, size_t size);

void collection_preview_set_count(int kind, int count);
