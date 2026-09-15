#include "touch_guard.h"
#include "scroll_gesture.h"
#include <assert.h>
#include <stdio.h>

static void tap(TouchGuard *g,int target,uint32_t at,bool allowed) {
  assert(touch_guard_down(g,target,20,20,at)==allowed);
  assert(touch_guard_up(g,target,20,20,at+50)==allowed);
}
int main(void) {
  ScrollGesture scroll = {0};
  int delta;
  scroll_gesture_down(&scroll, true, 20, 100);
  assert(!scroll_gesture_move(&scroll, 21, 95, &delta));
  assert(scroll_gesture_move(&scroll, 21, 75, &delta) && delta == -25);
  assert(scroll_gesture_move(&scroll, 21, 60, &delta) && delta == -15);
  assert(scroll_gesture_move(&scroll, 20, 100, &delta) && delta == 40);
  assert(scroll_gesture_up(&scroll)); // returning to the origin is still a drag
  assert(!scroll_gesture_up(&scroll));
  scroll_gesture_down(&scroll, true, 20, 100);
  assert(!scroll_gesture_move(&scroll, 60, 101, &delta));
  assert(!scroll_gesture_up(&scroll)); // horizontal actions still use the guard
  scroll_gesture_down(&scroll, false, 20, 100);
  assert(!scroll_gesture_move(&scroll, 20, 20, &delta));
  assert(!scroll_gesture_up(&scroll)); // menus and adjustable controls are excluded
  scroll_gesture_down(&scroll, true, 20, 100);
  assert(!scroll_gesture_up(&scroll)); // a stationary tap does not become scrolling
  TouchGuard g={0};
  tap(&g,1,100,false);tap(&g,1,250,true); // weather opens only on the second tap
  tap(&g,1,400,false); // every interaction needs its own arming tap
  tap(&g,2,550,false);tap(&g,2,650,true); // a different target cannot use the arm
  tap(&g,2,800,false);tap(&g,2,2401,false); // expired arm becomes a first tap
  tap(&g,2,2500,true);
  touch_guard_reset(&g);
  assert(!touch_guard_down(&g,3,0,0,3000));
  assert(!touch_guard_up(&g,3,0,0,4000));assert(!g.armed); // unarmed hold does not arm
  tap(&g,3,4100,false);
  assert(touch_guard_down(&g,3,20,20,4200)); // tap then hold permits the hold timer
  assert(touch_guard_up(&g,3,20,20,6000));assert(!g.armed);
  assert(!touch_guard_down(&g,4,0,0,6100));
  assert(!touch_guard_move(&g,30,0));assert(!touch_guard_move(&g,0,0));
  assert(!touch_guard_up(&g,4,0,0,6200));assert(!g.armed); // returning drag is not a tap
  tap(&g,4,6300,false);
  assert(touch_guard_down(&g,4,20,20,6400));
  assert(touch_guard_move(&g,100,50));assert(touch_guard_up(&g,4,100,50,6500)); // tap then drag
  tap(&g,1000,6600,false);tap(&g,1001,6700,false);tap(&g,1001,6800,true); // menu rows
  tap(&g,1100,6900,false);tap(&g,1100,7000,true); // outside-menu dismissal
  tap(&g,5,7100,false);touch_guard_reset(&g);tap(&g,5,7200,false); // screen/button reset
  touch_guard_reset(&g);tap(&g,1,UINT32_MAX-100,false);tap(&g,1,20,true); // clock wrap
  touch_guard_reset(&g);tap(&g,1,7300,false);
  assert(touch_guard_down(&g,1,20,20,7400));
  assert(!touch_guard_up(&g,2,21,20,7450)); // a tap cannot change targets at an edge
  touch_guard_reset(&g);
  assert(touch_guard_down_mode(&g,1,20,20,8000,false));
  assert(touch_guard_up(&g,1,20,20,8050));
  assert(touch_guard_down_mode(&g,1,20,20,8100,false));
  assert(touch_guard_up(&g,1,20,20,10100)); // single hold
  touch_guard_reset(&g);
  assert(!touch_guard_down_mode(&g,1,20,20,10200,true));
  assert(!touch_guard_up(&g,1,20,20,10250));
  puts("✓ touch guard: per-target tap, tap-hold, tap-drag, expiry, consumption, reset, clock wrap");
}
