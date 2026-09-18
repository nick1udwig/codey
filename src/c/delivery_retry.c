#include "delivery_retry.h"
#include <string.h>

#define MAX_RETRY_MS 60000

void delivery_retry_cancel(DeliveryRetry *retry) {
  if (retry->timer) { app_timer_cancel(retry->timer); retry->timer = NULL; }
}

void delivery_retry_reset(DeliveryRetry *retry, uint32_t initial_ms) {
  delivery_retry_cancel(retry);
  retry->delay_ms = initial_ms;
}

static void fire(void *context) {
  DeliveryRetry *retry = context;
  retry->timer = NULL;
  retry->attempt(retry->context);
}

void delivery_retry_schedule(DeliveryRetry *retry, bool connected,
                             void (*attempt)(void *), void *context) {
  if (!connected) { delivery_retry_cancel(retry); return; }
  if (retry->timer) { return; }
  retry->attempt = attempt;
  retry->context = context;
  retry->timer = app_timer_register(retry->delay_ms, fire, retry);
  if (retry->delay_ms < MAX_RETRY_MS) {
    retry->delay_ms *= 2;
    if (retry->delay_ms > MAX_RETRY_MS) { retry->delay_ms = MAX_RETRY_MS; }
  }
}

bool delivery_ack_advance(uint8_t *phase, const char *state) {
  uint8_t next = !strcmp(state,"accepted_phone") ? 1 :
    (!strcmp(state,"accepted_server") || !strcmp(state,"rejected") || !strcmp(state,"needs_attention")) ? 2 : 0;
  if (!next || *phase == 2 || *phase == next) { return false; }
  *phase = next;
  return true;
}
