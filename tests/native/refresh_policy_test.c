#include "refresh_policy.h"
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
  puts("✓ refresh policy: one passive frame per minute, immediate input, "
       "renewed deadline, clock wrap");
}
