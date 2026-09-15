#include "collection_preview.h"
#include "agent_protocol.h"
#include "capabilities/internal.h"
#include <string.h>

#define ROWS 8
#define TITLE_BYTES 72
#define CACHE_KEY 4480

static int key(int kind) { return CACHE_KEY + kind * 10; }
static void draw(AgentCapabilities *host, int kind, char titles[ROWS][TITLE_BYTES], int count, int flags, const char *status, const char *states, bool preview) {
  bool notes=kind==1, calendar=kind==2;
  AgentUi *ui=agent_capabilities_ui(host);
  agent_capabilities_set_collection_kind(host,kind);
  agent_capabilities_set_active(host,calendar?"calendar":notes?"notes":"todos",true);
  agent_ui_begin(ui,calendar?"calendar":notes?"notes":"todos","list",calendar?"Calendar":notes?"Notes":(flags&1)?"Completed":"To-dos",status,"",16);
  for(int i=0;i<count;i++) {
    char id[12];snprintf(id,sizeof(id),"r%d",i);
    const char *action=preview?"":calendar?"local.event.open":notes?"local.note.open":(flags&1)?"local.todo.restore":"local.todo.complete";
    char state=i<(int)strlen(states)?states[i]:'d';
    const char *subtitle=preview?"Cached preview":state=='p'?"Pending server":state=='s'?"Synced":state=='b'?"Backend pending":"Saved on server";
    agent_capability_add_element(ui,kind?"item":"choice",id,kind?titles[i]:"",subtitle,kind?"":titles[i],action,kind?"":"todo=true",(preview?1:0)|((flags&1)?2:0));
  }
  if(!count)agent_capability_add_element(ui,"text","empty","","","No items","","",0);
  if(!preview && (flags&2))agent_capability_add_element(ui,"item","next","Next page","","next",calendar?"local.event.list":notes?"local.note.list":"local.todo.list","",0);
  agent_capability_add_element(ui,"item","refresh","Refresh","","",calendar?"local.events":notes?"local.notes":"local.todos","",0);
  if(!preview&&!kind)agent_capability_add_element(ui,"item","state",(flags&1)?"Active tasks":"Completed tasks","","",(flags&1)?"local.todos":"local.todo.archive","",0);
  agent_ui_end(ui);
}
void collection_preview_receive(AgentCapabilities *host, int kind, const char *packed, int flags, const char *status, const char *states) {
  char titles[ROWS][TITLE_BYTES]={{0}};
  int count=0;
  while(*packed&&count<ROWS){
    const char *end=strchr(packed,'\n');size_t n=end?(size_t)(end-packed):strlen(packed);
    size_t keep=n<TITLE_BYTES-1?n:TITLE_BYTES-1;
    // Never cut a UTF-8 code point when accepting a longer future title.
    if(keep<n)while(keep&&(((unsigned char)packed[keep]&0xc0)==0x80))keep--;
    memcpy(titles[count++],packed,keep);packed+=n;if(*packed=='\n')packed++;
  }
  if(flags&16){
    int base=key(kind);unsigned dirty=0;
    for(int i=0;i<count;i++){
      char old[TITLE_BYTES];
      if(persist_read_data(base+1+i,old,sizeof(old))!=TITLE_BYTES||memcmp(old,titles[i],TITLE_BYTES))dirty|=1u<<i;
    }
    if(dirty||persist_read_int(base)!=count+1){
      // Invalidate first so interrupted writes cannot expose a mixed page.
      bool ok=persist_write_int(base,0)==(int)sizeof(int32_t);
      for(int i=0;ok&&i<count;i++)if(dirty&(1u<<i))ok=persist_write_data(base+1+i,titles[i],TITLE_BYTES)==TITLE_BYTES;
      if(ok)persist_write_int(base,count+1); // one means a cached empty collection
    }
  }
  draw(host,kind,titles,count,flags,status,states,false);
}
bool collection_preview_show(AgentCapabilities *host,int kind){
  int base=key(kind),count=persist_read_int(base)-1;
  if(count<0||count>ROWS)return false;
  char titles[ROWS][TITLE_BYTES]={{0}};
  for(int i=0;i<count;i++){
    if(persist_read_data(base+1+i,titles[i],TITLE_BYTES)!=TITLE_BYTES)return false;
    titles[i][TITLE_BYTES-1]=0;
  }
  draw(host,kind,titles,count,0,"Cached · Refreshing…","",true);return true;
}

void collection_preview_count(int kind,char *out,size_t size){int n=persist_exists(key(kind)+9)?persist_read_int(key(kind)+9):persist_read_int(key(kind))-1;snprintf(out,size,n<0?"0":"%d",n<0?0:n);}

void collection_preview_set_count(int kind,int count){if(kind<0||kind>2||count<0)return;int k=key(kind)+9;if(!persist_exists(k)||persist_read_int(k)!=count)persist_write_int(k,count);}
