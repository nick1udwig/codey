#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>

typedef int32_t WakeupId;
typedef struct Window Window;
typedef void (*WakeupHandler)(WakeupId wakeup_id, int32_t cookie);

void wakeup_service_subscribe(WakeupHandler handler);
void wakeup_cancel_all(void);
bool persist_exists(const uint32_t key);
int32_t persist_read_int(const uint32_t key);
int persist_write_int(const uint32_t key, const int32_t value);
typedef struct AppTimer AppTimer;
AppTimer *app_timer_register(uint32_t timeout_ms, void (*callback)(void *), void *context);
void app_timer_cancel(AppTimer *timer);
int persist_read_data(uint32_t key, void *data, size_t size);
int persist_write_data(uint32_t key, const void *data, size_t size);
WakeupId wakeup_schedule(time_t at, int32_t cookie, bool notify_if_missed);
void wakeup_cancel(WakeupId id);
bool clock_is_24h_style(void);
void vibes_double_pulse(void);
void vibes_short_pulse(void);
bool quiet_time_is_active(void);
void vibes_cancel(void);

int persist_delete(uint32_t key);
