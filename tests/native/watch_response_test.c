#include <assert.h>
#include "watch_response.h"
int main(void) {
  WatchResponse state = {0};
  assert(!watch_response_begin(&state, 42));
  watch_response_wait(&state);
  watch_response_fail(&state); // timeout before the phone handshake
  assert(!watch_response_begin(&state, 42));
  watch_response_wait(&state);
  assert(!watch_response_begin(&state, 0));
  assert(watch_response_begin(&state, 42));
  // An error with the phone ID works before render/begin; old IDs do not.
  assert(watch_response_accepts(&state, 42));
  assert(!watch_response_accepts(&state, 1));
  watch_response_fail(&state);
  assert(!watch_response_accepts(&state, 42));
  assert(!watch_response_begin(&state, 42));
  watch_response_wait(&state);
  assert(watch_response_begin(&state, 43));
  assert(!watch_response_accepts(&state, 42));
  assert(watch_response_accepts(&state, 43));
  return 0;
}
