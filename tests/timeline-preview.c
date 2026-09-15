// Isolated emulator fixture using the production renderer and capability routing.
#include "agent_ui.h"
#include "agent_capabilities.h"
#include "collection_preview.h"
#include <string.h>
static AgentUi *ui;
static AgentCapabilities *caps;
static int focus;
static int page;
static const char *titles[]={"Design review", "Lunch with Sam", "Release planning", "Out of office"};
static void list(void) {
  if(page){collection_preview_receive_timeline(caps,"Team check-in\nCoffee",32|(focus<<8),"Saved on server","ss",
      "day=2026-09-17 time=10:00 start=36000 end=37800\nday=2026-09-17 time=11:00 start=39600 end=41400");return;}
  collection_preview_receive_timeline(caps,"Design review\nLunch with Sam\nRelease planning\nOut of office",18|(focus<<8),"Saved on server","ssss",
      "day=2026-09-15 time=09:00 start=32400 end=36000 location=Studio\n"
      "day=2026-09-15 time=12:00 start=43200 end=46800 location=Courtyard\n"
      "day=2026-09-15 time=12:30 start=45000 end=48600 location=Office\n"
      "day=2026-09-16 time=\"All day\" start=0 end=86400 all_day=true");
}
static void request(const char *type,const char *id,const char *action,const char *value,void *context) {
  (void)context;
  if(strcmp(type,"calendar"))return;
  if(!strcmp(action,"list")){
    if(!strcmp(value,"next")){page=1;focus=0;}
    else if(!strcmp(value,"previous")){page=0;focus=3;}
    else if(strcmp(value,"return")){page=0;focus=0;}
    list();return;
  }
  if(!strcmp(action,"read")) {
    focus=id[1]>='0'&&id[1]<='3'?id[1]-'0':0;
    agent_ui_begin(ui,"event-detail","list",page?(focus?"Coffee":"Team check-in"):titles[focus],"","",16);
    agent_ui_add(ui,&(AgentUiElementSpec){.kind="text",.id="when",.value="Tue, Sep 15 · 12:00"});
    agent_ui_add(ui,&(AgentUiElementSpec){.kind="text",.id="until",.value="Ends at 13:00"});
    agent_ui_add(ui,&(AgentUiElementSpec){.kind="text",.id="where",.value="Courtyard"});
    agent_ui_add(ui,&(AgentUiElementSpec){.kind="text",.id="body",.value="Discuss the next release and share ideas over lunch."});
    agent_ui_add(ui,&(AgentUiElementSpec){.kind="bind",.id="back",.meta="input=back",.action="local.event.list",.value="return"});
    agent_ui_end(ui);
  }
}
static void event(const AgentUiEvent *e,void *context){(void)context;agent_capabilities_handle_ui_event(caps,e);}
int main(void) {
  ui=agent_ui_create(event,NULL,NULL);
  caps=agent_capabilities_create(ui,request,NULL);
  list();agent_ui_show(ui,false);app_event_loop();
  agent_capabilities_destroy(caps);agent_ui_destroy(ui);
}
