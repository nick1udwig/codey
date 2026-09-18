#include "refresh_policy.h"
#include "ui_invalidation.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
  RefreshPolicy p = {0};
  assert(refresh_policy_delay(&p, 100, false) == 0);
  refresh_policy_painted(&p, 100);
  assert(refresh_policy_delay(&p, 101, false) == 59999);
  assert(refresh_policy_delay(&p, 30100, false) == 30000);
  assert(refresh_policy_delay(&p, 60099, false) == 1);
  assert(refresh_policy_delay(&p, 60100, false) == 0);
  assert(refresh_policy_delay(&p, 500, true) == 0);
  refresh_policy_painted(&p, 500);
  assert(refresh_policy_delay(&p, 501, false) == 59999);
  refresh_policy_painted(&p, UINT32_MAX - 100);
  assert(refresh_policy_delay(&p, 50, false) == 59849);
  assert(refresh_policy_screen_delay(&p,51,false,true)==0);
  assert(refresh_policy_screen_delay(&p,51,false,false)>0);
  unsigned layouts=0, content=0, clocks=0;
  for(unsigned minute=1;minute<=10;minute++) {
    uint8_t work=ui_invalidation_expand(ui_invalidation_clock(false));
    layouts+=!!(work&UiDirtyGeometry);content+=!!(work&UiDirtyContent);clocks+=!!(work&UiDirtyClock);
    assert(!(work&UiDirtyActions));
  }
  assert(layouts==0 && content==0 && clocks==10);
  uint8_t calendar=ui_invalidation_expand(ui_invalidation_clock(true));
  assert((calendar&UiDirtyContent) && !(calendar&UiDirtyGeometry));
  uint8_t changed=ui_invalidation_expand(UiDirtyGeometry|UiDirtyClock);
  assert(changed==UiDirtyAll); // Real data/selection changes still update geometry.
  assert(!ui_invalidation_visible(false,false));
  assert(ui_invalidation_visible(false,true));
  assert(ui_invalidation_visible(true,false));
  puts("✓ refresh policy: one passive frame per minute, immediate input, "
       "renewed deadline, clock wrap");
}
