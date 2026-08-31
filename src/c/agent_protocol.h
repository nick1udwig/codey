#pragma once

#include <pebble.h>

// Reads one PAM-style name=value attribute from a compact metadata string.
// Returns true when the key exists. Quoted values and PAM escapes are decoded.
bool agent_protocol_meta_get(const char *meta, const char *key, char *dest, size_t dest_size);
int32_t agent_protocol_meta_get_int(const char *meta, const char *key, int32_t fallback);
bool agent_protocol_meta_get_bool(const char *meta, const char *key, bool fallback);
void agent_protocol_copy(char *dest, size_t dest_size, const char *source);

