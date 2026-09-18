#pragma once
#include <pebble.h>

// A single owned timer with capped exponential delay. The caller preserves the
// pending message and decides when a connection or acknowledgment cancels it.
typedef struct {
  AppTimer *timer;
  uint32_t delay_ms;
  void (*attempt)(void *);
  void *context;
} DeliveryRetry;
void delivery_retry_cancel(DeliveryRetry *retry);
void delivery_retry_reset(DeliveryRetry *retry, uint32_t initial_ms);
void delivery_retry_schedule(DeliveryRetry *retry, bool connected,
                             void (*attempt)(void *), void *context);
