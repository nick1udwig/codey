#include "collection_preview.h"
#include "agent_protocol.h"
#include "capabilities/internal.h"
#include <string.h>

#define ROWS 8
#define TITLE_BYTES 72
#define CACHE_KEY 4480
#define TIMELINE_META_KEY 4520
#define META_BYTES 192

static int key(int kind) { return CACHE_KEY + kind * 10; }
static void draw(AgentCapabilities *host, int kind, char titles[ROWS][TITLE_BYTES], char metadata[ROWS][META_BYTES], int count, int flags, const char *status, const char *states, bool preview) {
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
    agent_capability_add_element(ui,kind?"item":"choice",id,kind?titles[i]:"",subtitle,kind?"":titles[i],action,calendar?metadata[i]:kind?"":"todo=true",(preview?1:0)|((flags&1)?2:0)|(calendar&&i==((flags>>8)&7)?64:0));
  }
  if(!count)agent_capability_add_element(ui,"text","empty","","","No items","","",0);
  if(!preview && (flags&2))agent_capability_add_element(ui,calendar?"bind":"item","next","Next page","","next",calendar?"local.event.list":notes?"local.note.list":"local.todo.list",calendar?"input=timeline-next":"",0);
  if(calendar&&!preview&&(flags&32))agent_capability_add_element(ui,"bind","previous","","","previous","local.event.list","input=timeline-previous",0);
  agent_capability_add_element(ui,"item","refresh","Refresh","","",calendar?"local.events":notes?"local.notes":"local.todos","",0);
  if(!preview&&!kind)agent_capability_add_element(ui,"item","state",(flags&1)?"Active tasks":"Completed tasks","","",(flags&1)?"local.todos":"local.todo.archive","",0);
  agent_ui_end(ui);
}
static void receive(AgentCapabilities *host, int kind, const char *packed, int flags, const char *status, const char *states, const char *meta) {
  char titles[ROWS][TITLE_BYTES]={{0}};
  char metadata[ROWS][META_BYTES]={{0}};
  int count=0;
  while(*packed&&count<ROWS){
    const char *end=strchr(packed,'\n');size_t n=end?(size_t)(end-packed):strlen(packed);
    size_t keep=n<TITLE_BYTES-1?n:TITLE_BYTES-1;
    // Never cut a UTF-8 code point when accepting a longer future title.
    if(keep<n)while(keep&&(((unsigned char)packed[keep]&0xc0)==0x80))keep--;
    memcpy(titles[count++],packed,keep);packed+=n;if(*packed=='\n')packed++;
  }
  for(int i=0;kind==2&&i<count&&*meta;i++) {
    const char *end=strchr(meta,'\n');size_t n=end?(size_t)(end-meta):strlen(meta);
    // Ignore malformed oversized metadata rather than accepting partial attributes.
    if(n<META_BYTES)memcpy(metadata[i],meta,n);
    meta+=n;if(*meta=='\n')meta++;
  }
  if(flags&16){
    int base=key(kind);unsigned dirty=0;
    for(int i=0;i<count;i++){
      char old[TITLE_BYTES];
      if(persist_read_data(base+1+i,old,sizeof(old))!=TITLE_BYTES||memcmp(old,titles[i],TITLE_BYTES))dirty|=1u<<i;
      if(kind==2){char old_meta[META_BYTES];if(persist_read_data(TIMELINE_META_KEY+i,old_meta,sizeof(old_meta))!=META_BYTES||memcmp(old_meta,metadata[i],META_BYTES))dirty|=1u<<i;}
    }
    if(dirty||persist_read_int(base)!=count+1){
      // Invalidate first so interrupted writes cannot expose a mixed page.
      bool ok=persist_write_int(base,0)==(int)sizeof(int32_t);
      for(int i=0;ok&&i<count;i++)if(dirty&(1u<<i)){
        ok=persist_write_data(base+1+i,titles[i],TITLE_BYTES)==TITLE_BYTES;
        if(ok&&kind==2)ok=persist_write_data(TIMELINE_META_KEY+i,metadata[i],META_BYTES)==META_BYTES;
      }
      if(ok)persist_write_int(base,count+1); // one means a cached empty collection
    }
  }
  draw(host,kind,titles,metadata,count,flags,status,states,false);
}
void collection_preview_receive(AgentCapabilities *host,int kind,const char *packed,int flags,const char *status,const char *states){receive(host,kind,packed,flags,status,states,"");}
void collection_preview_receive_timeline(AgentCapabilities *host,const char *packed,int flags,const char *status,const char *states,const char *metadata){receive(host,2,packed,flags,status,states,metadata);}
bool collection_preview_show(AgentCapabilities *host,int kind){
  int base=key(kind),count=persist_read_int(base)-1;
  if(count<0||count>ROWS)return false;
  char titles[ROWS][TITLE_BYTES]={{0}};
  char metadata[ROWS][META_BYTES]={{0}};
  for(int i=0;i<count;i++){
    if(persist_read_data(base+1+i,titles[i],TITLE_BYTES)!=TITLE_BYTES)return false;
    titles[i][TITLE_BYTES-1]=0;
    if(kind==2){if(persist_read_data(TIMELINE_META_KEY+i,metadata[i],META_BYTES)!=META_BYTES)metadata[i][0]=0;metadata[i][META_BYTES-1]=0;}
  }
  draw(host,kind,titles,metadata,count,0,"Cached · Refreshing…","",true);return true;
}

void collection_preview_count(int kind,char *out,size_t size){int n=persist_exists(key(kind)+9)?persist_read_int(key(kind)+9):persist_read_int(key(kind))-1;snprintf(out,size,n<0?"0":"%d",n<0?0:n);}

void collection_preview_set_count(int kind,int count){if(kind<0||kind>2||count<0)return;int k=key(kind)+9;if(!persist_exists(k)||persist_read_int(k)!=count)persist_write_int(k,count);}
