#include "gesture_controller.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
  GestureController gesture={0};
  assert(!gesture_controller_contact(&gesture,GestureDown,10,20,20,100,true));
  assert(!gesture_controller_contact(&gesture,GestureUp,10,20,20,110,true));
  assert(gesture_controller_contact(&gesture,GestureDown,10,20,20,120,true));
  assert(gesture_controller_contact(&gesture,GestureUp,10,20,20,130,true));
  gesture_controller_reset(&gesture);
  assert(gesture_controller_contact(&gesture,GestureDown,10,20,20,200,false));
  assert(!gesture_controller_contact(&gesture,GestureUp,11,20,20,210,false));
  gesture_controller_reset(&gesture);
  assert(!gesture.guard.armed);
  puts("gesture controller: arming, immediate mode, changed targets and reset");
}
