#include "internal.h"
#include "../collection_preview.h"
#include <string.h>

// Only display titles are cached; mutations still require live phone aliases.
static void request(AgentCapabilities *host, const char *id, const char *action, const char *value) {
  agent_capabilities_set_collection(host, false);
  agent_capabilities_set_active(host, "todos", true);
  AgentUi *ui=agent_capabilities_ui(host);
  bool preview=!strcmp(action,"list") && strcmp(value,"next") && collection_preview_show(host,false);
  if(!preview) {
  agent_ui_begin(ui,"todos","list","To-dos","","",16);
  agent_capability_add_element(ui,"text","loading","","","Loading from phone…","","",0);
  agent_ui_end(ui);
  }
  agent_capabilities_emit(host,"todo",id,action,value);
}
static bool command(AgentCapabilities *host,const AgentCapabilityCommand *c,void *context) {
  (void)context;
  if(!strcmp(c->command,"list")||!strcmp(c->command,"archive")){request(host,"",c->command,"0");return true;}
  return false;
}
static bool event(AgentCapabilities *host,const AgentUiEvent *e,void *context) {
  (void)context;
  if(!strcmp(e->action,"local.todos")){request(host,"","list","0");return true;}
  if(!strcmp(e->action,"local.todo.archive")){request(host,"","archive","0");return true;}
  if(!strcmp(e->action,"local.todo.list")){request(host,e->element_id,"list",e->value);return true;}
  if(!strcmp(e->action,"local.todo.complete")||!strcmp(e->action,"local.todo.restore")){request(host,e->element_id,!strcmp(e->action,"local.todo.complete")?"complete":"restore","");return true;}
  return false;
}
static void dashboard(AgentCapabilities *host,void *context,bool refresh){(void)context;(void)refresh;if(!agent_capabilities_collection_is_notes(host))agent_capability_patch_value(agent_capabilities_ui(host),"todos","-");}
bool agent_todos_install(AgentCapabilities *host){return agent_capabilities_register(host,"todo",(AgentCapabilityModule){.command=command,.event=event,.dashboard=dashboard},NULL);}
