#pragma once
#include <pebble.h>
#include <stdint.h>
#include <stdio.h>

// Shared local identity allocator. Provider IDs belong in a future mapping
// table, never in UI row indexes. A phone installation namespace will scope
// these IDs when records are first synchronized between devices.
#define RECORD_SEQUENCE_KEY 4398
static inline bool record_identity(char *id, size_t size) {
  uint32_t sequence = (uint32_t)persist_read_int(RECORD_SEQUENCE_KEY) + 1u;
  if (!sequence || persist_write_int(RECORD_SEQUENCE_KEY, (int32_t)sequence) !=
                       sizeof(int32_t))
    return false;
  snprintf(id, size, "local-%08lx-%08lx", (unsigned long)time(NULL),
           (unsigned long)sequence);
  return true;
}
