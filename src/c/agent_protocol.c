#include "agent_protocol.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

void agent_protocol_copy(char *dest, size_t dest_size, const char *source) {
  if (!dest || !dest_size) {
    return;
  }
  if (!source) { dest[0] = '\0'; return; }
  size_t length = strlen(source);
  if (length >= dest_size) {
    length = dest_size - 1;
    // Never end a display string in the middle of a UTF-8 code point.
    while (length && ((unsigned char)source[length] & 0xc0) == 0x80) { --length; }
  }
  memmove(dest, source, length);
  dest[length] = '\0';
}

bool agent_protocol_update(char *dest, size_t dest_size, const char *source) {
  if (!dest || !dest_size) { return false; }
  if (!source) { source = ""; }
  size_t length = 0;
  while (length + 1 < dest_size && source[length]) { length++; }
  while (length && ((unsigned char)source[length] & 0xc0) == 0x80) { length--; }
  if (strlen(dest) == length && !memcmp(dest, source, length)) { return false; }
  memmove(dest, source, length);
  dest[length] = '\0';
  return true;
}

static bool prv_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }
static bool prv_alnum(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

static bool prv_key_matches(const char *start, size_t length, const char *key) {
  return key && strlen(key) == length && strncmp(start, key, length) == 0;
}

static char prv_decode_escape(char value) {
  switch (value) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case '\\': return '\\';
    case '\"': return '\"';
    case '\'': return '\'';
    default: return value;
  }
}

static bool prv_meta_get(const char *meta, const char *key, char *dest, size_t dest_size, bool *truncated) {
  const char *cursor = meta;

  if (dest && dest_size) {
    dest[0] = '\0';
  }
  if (!meta || !key || !dest || !dest_size) {
    return false;
  }

  while (*cursor) {
    const char *key_start;
    const char *value_start;
    size_t key_length;
    size_t written = 0;
    char quote = '\0';

    while (*cursor && prv_space(*cursor)) {
      cursor += 1;
    }
    if (!*cursor) {
      break;
    }
    key_start = cursor;
    while (*cursor && (prv_alnum(*cursor) || *cursor == '_' || *cursor == '-')) {
      cursor += 1;
    }
    key_length = (size_t)(cursor - key_start);
    if (!key_length || *cursor != '=') {
      while (*cursor && !prv_space(*cursor)) {
        cursor += 1;
      }
      continue;
    }
    cursor += 1;
    if (*cursor == '\"' || *cursor == '\'') {
      quote = *cursor;
      cursor += 1;
    }
    value_start = cursor;
    if (!prv_key_matches(key_start, key_length, key)) {
      if (quote) {
        while (*cursor && *cursor != quote) {
          if (*cursor == '\\' && cursor[1]) {
            cursor += 2;
          } else {
            cursor += 1;
          }
        }
        if (*cursor == quote) {
          cursor += 1;
        }
      } else {
        while (*cursor && !prv_space(*cursor)) {
          cursor += 1;
        }
      }
      continue;
    }

    cursor = value_start;
    while (*cursor && ((quote && *cursor != quote) || (!quote && !prv_space(*cursor)))) {
      char value = *cursor;
      if (value == '\\' && cursor[1]) {
        cursor += 1;
        value = prv_decode_escape(*cursor);
      }
      if (written + 1 < dest_size) {
        dest[written++] = value;
      } else if (truncated) { *truncated = true; }
      cursor += 1;
    }
    dest[written] = '\0';
    return true;
  }
  return false;
}

bool agent_protocol_meta_get(const char *meta, const char *key, char *dest, size_t dest_size) {
  return prv_meta_get(meta, key, dest, dest_size, NULL);
}

int32_t agent_protocol_meta_get_int(const char *meta, const char *key, int32_t fallback) {
  char value[24];
  int32_t result;
  bool truncated = false;
  if (!prv_meta_get(meta, key, value, sizeof(value), &truncated) || truncated) {
    return fallback;
  }
  return agent_protocol_parse_int32(value, NULL, &result) ? result : fallback;
}

bool agent_protocol_parse_int32(const char *value, const char **end, int32_t *result) {
  const char *cursor;
  uint32_t magnitude = 0;
  uint32_t limit;
  bool negative = false;

  if (!value || !value[0] || !result) { return false; }
  cursor = value;
  if (*cursor == '-' || *cursor == '+') {
    negative = *cursor == '-';
    cursor += 1;
  }
  if (*cursor < '0' || *cursor > '9') { return false; }
  limit = negative ? (uint32_t)INT32_MAX + 1u : (uint32_t)INT32_MAX;
  while (*cursor >= '0' && *cursor <= '9') {
    uint32_t digit;
    digit = (uint32_t)(*cursor - '0');
    if (magnitude > (limit - digit) / 10u) { return false; }
    magnitude = magnitude * 10u + digit;
    cursor += 1;
  }
  if (!end && *cursor) { return false; }
  if (end) { *end = cursor; }
  if (!negative) { *result = (int32_t)magnitude; }
  else if (magnitude == (uint32_t)INT32_MAX + 1u) { *result = INT32_MIN; }
  else { *result = -(int32_t)magnitude; }
  return true;
}

bool agent_protocol_meta_get_bool(const char *meta, const char *key, bool fallback) {
  char value[12];
  if (!agent_protocol_meta_get(meta, key, value, sizeof(value))) {
    return fallback;
  }
  if (strcmp(value, "true") == 0 || strcmp(value, "yes") == 0 || strcmp(value, "1") == 0) {
    return true;
  }
  if (strcmp(value, "false") == 0 || strcmp(value, "no") == 0 || strcmp(value, "0") == 0) {
    return false;
  }
  return fallback;
}
