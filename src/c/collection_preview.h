#pragma once
#include "agent_capabilities.h"
// flags: completed=1, next page=2, cached phone page=4, partial=8, first active page=16.
void collection_preview_receive(AgentCapabilities *host, bool notes, const char *titles, int flags, const char *status, const char *states);
bool collection_preview_show(AgentCapabilities *host, bool notes);
