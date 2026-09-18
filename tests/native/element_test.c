#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "agent_ui_element.h"
#include "agent_protocol.h"

int main(void) {
  AgentUiElement element = {0};
  AgentUiElementSpec full = {.kind="text", .id="one", .title="Title", .value="Value", .flags=1};
  assert(agent_ui_element_apply(&element, &full, false));
  assert(!agent_ui_element_apply(&element, &full, false));
  AgentUiElementSpec patch = {.id="one", .value="", .present=AgentUiPresentValue};
  assert(agent_ui_element_apply(&element, &patch, true));
  assert(!strcmp(element.title,"Title") && !element.value[0] && element.flags==1);
  assert(!agent_ui_element_apply(&element, &patch, true));
  patch.present=0;patch.flags=0;
  assert(!agent_ui_element_apply(&element,&patch,true));
  char long_value[1000];memset(long_value,'x',sizeof(long_value));long_value[999]=0;
  memcpy(long_value+318,"🌙",4);
  patch.value=long_value;patch.present=AgentUiPresentValue;
  assert(agent_ui_element_apply(&element,&patch,true));assert(strlen(element.value)==318);
  long_value[500]='y';assert(!agent_ui_element_apply(&element,&patch,true));
  patch.present=AgentUiPresentFlags;patch.flags=64;
  assert(agent_ui_element_apply(&element,&patch,true));assert(element.flags==64);
  // Compare normalization against the existing copy contract at every boundary.
  const char *source="abc🌙漢é end";
  for(size_t size=1;size<32;size++) {
    char expected[32]={0},actual[32]={0};
    agent_protocol_copy(expected,size,source);
    agent_protocol_update(actual,size,source);
    assert(!strcmp(actual,expected));
    assert(!agent_protocol_update(actual,size,source));
  }
  puts("element field normalization and no-op patch tests passed");
}
