#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "range_control.h"
#include "local_action.h"
int main(void) {
  assert(range_slider(-50, 100, 60, 3600, 60) == 60);
  assert(range_slider(150, 100, 60, 3600, 60) == 3600);
  assert(range_slider(50, 100, 0, 3600, 60) == 1800);
  assert(range_quantize(119, 60, 3600, 60) == 120);
  assert(range_angle_delta(500, 65000) == 1036);
  assert(range_angle_delta(65000, 500) == -1036);
  AgentUiEvent event = {0}; AgentCapabilityCommand command;
  char type[20], task[72], args[48];
  strcpy(event.meta, "capability=reminder seconds=86400 task=\"Birthday card\"");
  assert(local_action_build(&event, &command, type, task, args, sizeof(args)));
  assert(strcmp(command.type, "reminder") == 0 && strcmp(command.command, "schedule") == 0);
  assert(strcmp(command.title, "Birthday card") == 0 && strcmp(command.meta, "in=86400s") == 0);
  strcpy(event.meta, "capability=timer seconds=\"$value\" task=Pasta"); strcpy(event.value, "300");
  assert(local_action_build(&event, &command, type, task, args, sizeof(args)));
  assert(strcmp(command.meta, "duration=300s") == 0);
  strcpy(event.value, "0"); assert(!local_action_build(&event, &command, type, task, args, sizeof(args)));
  strcpy(event.value, "604801"); assert(!local_action_build(&event, &command, type, task, args, sizeof(args)));
  strcpy(event.meta, "capability=shell seconds=1 task=bad");
  assert(!local_action_build(&event, &command, type, task, args, sizeof(args)));
  puts("✓ range bounds, quantization, dial seam and declarative local action limits");
}
