#include "agent_protocol.h"

#include <ctype.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

void agent_protocol_copy(char *dest, size_t dest_size, const char *source) {
  if (!dest || !dest_size) {
    return;
  }
  snprintf(dest, dest_size, "%s", source ? source : "");
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

bool agent_protocol_meta_get(const char *meta, const char *key, char *dest, size_t dest_size) {
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

    while (*cursor && isspace((unsigned char)*cursor)) {
      cursor += 1;
    }
    if (!*cursor) {
      break;
    }
    key_start = cursor;
    while (*cursor && (isalnum((unsigned char)*cursor) || *cursor == '_' || *cursor == '-')) {
      cursor += 1;
    }
    key_length = (size_t)(cursor - key_start);
    if (!key_length || *cursor != '=') {
      while (*cursor && !isspace((unsigned char)*cursor)) {
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
        while (*cursor && !isspace((unsigned char)*cursor)) {
          cursor += 1;
        }
      }
      continue;
    }

    cursor = value_start;
    while (*cursor && ((quote && *cursor != quote) || (!quote && !isspace((unsigned char)*cursor)))) {
      char value = *cursor;
      if (value == '\\' && cursor[1]) {
        cursor += 1;
        value = prv_decode_escape(*cursor);
      }
      if (written + 1 < dest_size) {
        dest[written++] = value;
      }
      cursor += 1;
    }
    dest[written] = '\0';
    return true;
  }
  return false;
}

int32_t agent_protocol_meta_get_int(const char *meta, const char *key, int32_t fallback) {
  char value[24];
  const char *cursor;
  uint32_t magnitude = 0;
  uint32_t limit;
  bool negative = false;

  if (!agent_protocol_meta_get(meta, key, value, sizeof(value)) || !value[0]) {
    return fallback;
  }
  cursor = value;
  if (*cursor == '-' || *cursor == '+') {
    negative = *cursor == '-';
    cursor += 1;
  }
  if (!*cursor) { return fallback; }
  limit = negative ? (uint32_t)INT32_MAX + 1u : (uint32_t)INT32_MAX;
  while (*cursor) {
    uint32_t digit;
    if (*cursor < '0' || *cursor > '9') { return fallback; }
    digit = (uint32_t)(*cursor - '0');
    if (magnitude > (limit - digit) / 10u) { return fallback; }
    magnitude = magnitude * 10u + digit;
    cursor += 1;
  }
  if (!negative) { return (int32_t)magnitude; }
  if (magnitude == (uint32_t)INT32_MAX + 1u) { return INT32_MIN; }
  return -(int32_t)magnitude;
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
