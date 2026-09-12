#include <assert.h>
#include "answer_notification.h"

static bool quiet;
static int pulses;
bool quiet_time_is_active(void) { return quiet; }
void vibes_short_pulse(void) { ++pulses; }

int main(void) {
  AnswerNotification state = { .request_id = 7, .pending = true };
  answer_notification_complete(&state, 0, true);
  answer_notification_complete(&state, 6, true);
  assert(pulses == 0 && state.pending);
  answer_notification_complete(&state, 7, true);
  answer_notification_complete(&state, 7, true);
  assert(pulses == 1 && !state.pending);
  state = (AnswerNotification) { .request_id = 8, .pending = true };
  quiet = true;
  answer_notification_complete(&state, 8, true);
  quiet = false;
  answer_notification_complete(&state, 8, true);
  assert(pulses == 1 && !state.pending);
  state = (AnswerNotification) { .request_id = 9, .pending = true };
  answer_notification_complete(&state, 9, false);
  answer_notification_complete(&state, 9, true);
  assert(pulses == 1 && !state.pending);
  return 0;
}
