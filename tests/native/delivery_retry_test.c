#include <assert.h>
#include <stdio.h>
#include "delivery_retry.h"

struct AppTimer { void (*callback)(void *); void *context; uint32_t delay; bool live; };
static struct AppTimer timer;
static unsigned attempts;
static bool connected;
static DeliveryRetry retry;
AppTimer *app_timer_register(uint32_t delay, void (*callback)(void *), void *context) {
  assert(!timer.live);
  timer = (struct AppTimer){callback, context, delay, true};
  return &timer;
}
void app_timer_cancel(AppTimer *value) { assert(value == &timer); timer.live = false; }
static void attempt(void *context) {
  assert(context == &attempts);
  attempts++;
  delivery_retry_schedule(&retry, connected, attempt, context);
}
static void fire(void) {
  assert(timer.live);
  timer.live = false;
  timer.callback(timer.context);
}
static void outage(uint32_t initial) {
  attempts = 0; connected = true;
  delivery_retry_reset(&retry, initial);
  delivery_retry_schedule(&retry, connected, attempt, &attempts);
  unsigned elapsed = 0;
  while (elapsed + timer.delay <= 3600000) {
    elapsed += timer.delay;
    fire();
    // Scheduling twice must not replace the timer or advance its delay.
    uint32_t delay = retry.delay_ms;
    delivery_retry_schedule(&retry, true, attempt, &attempts);
    assert(delay == retry.delay_ms);
  }
  assert(attempts < 70);
  connected = false;
  delivery_retry_schedule(&retry, connected, attempt, &attempts);
  assert(!timer.live && !retry.timer);
  // Reconnection resets the responsive window. Acknowledgment cancels it.
  connected = true;
  delivery_retry_reset(&retry, initial);
  attempt(&attempts);
  assert(timer.live && timer.delay == initial);
  delivery_retry_cancel(&retry);
  assert(!timer.live && !retry.timer);
  delivery_retry_cancel(&retry);
}
int main(void) {
  uint8_t phase=0;
  assert(!delivery_ack_advance(&phase,"unknown"));
  assert(delivery_ack_advance(&phase,"accepted_phone"));
  assert(!delivery_ack_advance(&phase,"accepted_phone"));
  assert(delivery_ack_advance(&phase,"accepted_server"));
  assert(!delivery_ack_advance(&phase,"accepted_server"));
  assert(!delivery_ack_advance(&phase,"accepted_phone"));
  phase=0;assert(delivery_ack_advance(&phase,"rejected"));
  assert(!delivery_ack_advance(&phase,"accepted_phone"));
  phase=1;assert(delivery_ack_advance(&phase,"needs_attention"));
  outage(3000); // Connected phone with missing collection acknowledgments.
  outage(100); // Sustained APP_MSG_BUSY.
  puts("delivery retry tests passed");
}
