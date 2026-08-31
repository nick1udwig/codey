#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

typedef int32_t WakeupId;
typedef struct Window Window;
typedef void (*WakeupHandler)(WakeupId wakeup_id, int32_t cookie);

void wakeup_service_subscribe(WakeupHandler handler);
void wakeup_cancel_all(void);
bool persist_exists(const uint32_t key);
int32_t persist_read_int(const uint32_t key);
int persist_write_int(const uint32_t key, const int32_t value);
