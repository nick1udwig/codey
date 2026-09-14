#include "agent_capabilities.h"
#include "agent_protocol.h"
#include "collection_preview.h"
#include "touch_guard.h"
#include <assert.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

static time_t now = 100000;
static int buzzes, canceled, writes_fail, writes, timer_callbacks;
static bool wake_fail;
static int next_wake;
static WakeupId wake_id = -1;
static time_t wake_at;
static int32_t wake_cookie;
static WakeupHandler wake_handler;
static struct { size_t size; unsigned char data[256]; } storage[4700];
struct AppTimer { bool used; time_t at; void (*callback)(void *); void *context; };
static AppTimer timers[16];
struct AgentUi { char screen[32], status[100]; int count; int32_t flags;
  struct { char id[32], title[72], subtitle[100], value[320], action[48], meta[224]; } elements[48]; };
static AgentUi ui;

time_t time(time_t *out) { if (out) { *out = now; } return now; }
AppTimer *app_timer_register(uint32_t ms, void (*cb)(void *), void *ctx) {
  for (int i = 0; i < 16; ++i) { if (!timers[i].used) {
    timers[i] = (AppTimer){ true, now + (ms + 999) / 1000, cb, ctx }; return &timers[i];
  } }
  abort();
}
void app_timer_cancel(AppTimer *timer) { timer->used = false; }
void wakeup_service_subscribe(WakeupHandler handler) { wake_handler = handler; }
void wakeup_cancel_all(void) { wake_id = -1; }
void wakeup_cancel(WakeupId id) { if (id == wake_id) { wake_id = -1; } }
WakeupId wakeup_schedule(time_t at, int32_t cookie, bool notify) {
  assert(notify && at > now);
  if (wake_fail) { return -1; }
  // A shared scheduler should never request a second concurrent wakeup.
  assert(wake_id == -1);
  wake_at = at; wake_cookie = cookie; wake_id = ++next_wake; return wake_id;
}
bool persist_exists(uint32_t key) { assert(key < 4700); return storage[key].size != 0; }
int persist_write_data(uint32_t key, const void *data, size_t size) {
  assert(key < 4700 && size <= 256);
  if (writes_fail) { return -1; }
  ++writes;
  memcpy(storage[key].data, data, size); storage[key].size = size; return (int)size;
}
int persist_read_data(uint32_t key, void *data, size_t size) {
  assert(key < 4700);
  if (!storage[key].size) { return -1; }
  size_t copy = size < storage[key].size ? size : storage[key].size;
  memcpy(data, storage[key].data, copy); return (int)copy;
}
int32_t persist_read_int(uint32_t key) { int32_t value = 0; persist_read_data(key, &value, sizeof(value)); return value; }
int persist_write_int(uint32_t key, int32_t value) { return persist_write_data(key, &value, sizeof(value)); }
bool clock_is_24h_style(void) { return true; }
bool quiet_time_is_active(void) { return false; }
void vibes_short_pulse(void) { ++buzzes; }
int persist_delete(uint32_t key) { storage[key].size = 0; return 0; }
void vibes_double_pulse(void) { ++buzzes; }
void vibes_cancel(void) { ++canceled; }
void agent_ui_begin(AgentUi *u, const char *id, const char *layout, const char *title,
                    const char *subtitle, const char *meta, int32_t flags) {
  (void)layout; (void)title; (void)subtitle; (void)meta; (void)flags;
  u->flags = flags; u->count = 0; u->status[0] = 0; agent_protocol_copy(u->screen, sizeof(u->screen), id);
}
const char *agent_ui_screen_id(const AgentUi *u) { return u->screen; }
static int element(const char *id) {
  for (int i = 0; i < ui.count; ++i) { if (strcmp(ui.elements[i].id, id) == 0) { return i; } }
  return -1;
}
bool agent_ui_add(AgentUi *u, const AgentUiElementSpec *spec) {
  assert(u->count < 48 && element(spec->id) == -1);
  int i = u->count++;
  memset(&u->elements[i], 0, sizeof(u->elements[i]));
  agent_protocol_copy(u->elements[i].id, 32, spec->id);
  agent_protocol_copy(u->elements[i].title, 72, spec->title);
  agent_protocol_copy(u->elements[i].subtitle, 100, spec->subtitle);
  agent_protocol_copy(u->elements[i].value, 320, spec->value);
  agent_protocol_copy(u->elements[i].action, 48, spec->action);
  agent_protocol_copy(u->elements[i].meta, 224, spec->meta);
  return true;
}
bool agent_ui_patch(AgentUi *u, const AgentUiElementSpec *spec) {
  int i = element(spec->id); if (i < 0) { return false; }
  if (spec->present & AgentUiPresentMeta) { agent_protocol_copy(u->elements[i].meta, 224, spec->meta); }
  if (spec->present & AgentUiPresentValue) { agent_protocol_copy(u->elements[i].value, 320, spec->value); }
  if (spec->present & AgentUiPresentSubtitle) { agent_protocol_copy(u->elements[i].subtitle, 100, spec->subtitle); }
  return true;
}
void agent_ui_note_input(AgentUi *u) { (void)u; }
void agent_ui_refresh_clock(AgentUi *u) { (void)u; }
void agent_ui_end(AgentUi *u) { (void)u; }
void agent_ui_set_status(AgentUi *u, const char *status, bool error, bool loading) {
  (void)error; (void)loading; agent_protocol_copy(u->status, sizeof(u->status), status);
}
static void advance(int seconds) {
  while (seconds-- > 0) {
    ++now;
    if (wake_id >= 0 && wake_at <= now) {
      WakeupId id = wake_id; wake_id = -1; wake_handler(id, wake_cookie);
    }
    for (int i = 0; i < 16; ++i) { if (timers[i].used && timers[i].at <= now) {
      void (*cb)(void *) = timers[i].callback; void *ctx = timers[i].context;
      timers[i].used = false; ++timer_callbacks; cb(ctx);
    } }
  }
}
static void command(AgentCapabilities *caps, const char *type, const char *op, const char *id, const char *meta) {
  AgentCapabilityCommand cmd = { .type = type, .command = op, .id = id, .title = id, .meta = meta };
  assert(agent_capabilities_handle_command(caps, &cmd));
}
static void event(AgentCapabilities *caps, const char *action) {
  AgentUiEvent e = {0}; agent_protocol_copy(e.action, sizeof(e.action), action);
  assert(agent_capabilities_handle_ui_event(caps, &e));
}
static void reset(void) {
  memset(storage, 0, sizeof(storage)); memset(timers, 0, sizeof(timers)); memset(&ui, 0, sizeof(ui));
  wake_id = -1; buzzes = canceled = writes_fail = writes = timer_callbacks = 0; wake_fail = false; now = 100000;
}
static void test_weather_summary(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  agent_capabilities_set_weather(caps, "58F", "L 46 H 68", "icon=moon");
  assert(strcmp(ui.elements[element("weather")].value, "58F") == 0);
  event(caps, "local.calendar"); assert(ui.flags & 16);
  agent_capabilities_set_weather(caps, "60F", "L 46 H 68", "icon=sun");
  assert(strcmp(ui.screen, "calendar") == 0);
  event(caps, "local.home");
  assert(strcmp(ui.elements[element("weather")].value, "60F") == 0);
  assert(strcmp(ui.elements[element("weather")].meta, "icon=sun") == 0);
  agent_capabilities_destroy(caps);
}

static char todo_action[24];
static void todo_event(const char *type,const char *id,const char *action,const char *value,void *context) {
  (void)id;(void)value;(void)context;if(!strcmp(type,"todo"))agent_protocol_copy(todo_action,sizeof(todo_action),action);
}
static void test_todos(void) {
  reset(); AgentCapabilities *caps=agent_capabilities_create(&ui,todo_event,NULL);
  assert(!strcmp(ui.elements[element("todos")].value,"-"));int before=writes;
  event(caps,"local.todos");assert(!strcmp(todo_action,"list"));
  event(caps,"local.todo.complete");assert(!strcmp(todo_action,"complete"));
  event(caps,"local.todo.restore");assert(!strcmp(todo_action,"restore"));
  event(caps,"local.todo.archive");assert(!strcmp(todo_action,"archive"));
  AgentCapabilityCommand cmd={.type="todo",.command="add",.value="Never persist this"};
  assert(!agent_capabilities_handle_command(caps,&cmd));assert(writes==before);
  agent_capabilities_destroy(caps);
}

static void test_collection_previews(void) {
  reset();AgentCapabilities *caps=agent_capabilities_create(&ui,todo_event,NULL);
  assert(!collection_preview_show(caps,false));
  collection_preview_receive(caps,false,"Buy milk\nCall José",16,"Saved on server","dp");
  assert(!strcmp(ui.elements[element("r0")].action,"local.todo.complete"));
  assert(!strcmp(ui.elements[element("r1")].subtitle,"Pending server"));
  agent_capabilities_destroy(caps);
  caps=agent_capabilities_create(&ui,todo_event,NULL);
  assert(collection_preview_show(caps,false));
  assert(!strcmp(ui.elements[element("r0")].value,"Buy milk"));
  assert(!ui.elements[element("r0")].action[0]);
  collection_preview_receive(caps,false,"Completed item",1,"Saved","d");
  assert(collection_preview_show(caps,false));
  assert(!strcmp(ui.elements[element("r0")].value,"Buy milk"));
  collection_preview_receive(caps,true,"Note title",16,"Saved","d");
  assert(collection_preview_show(caps,true));
  assert(!strcmp(ui.elements[element("r0")].title,"Note title"));
  collection_preview_receive(caps,false,"",16,"Saved","");
  assert(collection_preview_show(caps,false));assert(element("r0")<0);
  storage[4491].size=0;assert(!collection_preview_show(caps,true));
  agent_capabilities_destroy(caps);
}

static int timer_progress(void) {
  int index = element("schedule-0"); assert(index >= 0);
  return agent_protocol_meta_get_int(ui.elements[index].meta, "progress", -1);
}
static void test_dashboard_progress(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  assert(element("schedule-0") < 0);
  command(caps, "timer", "start", "Pasta", "duration=100s show=false");
  assert(timer_progress() == 0);
  assert(strcmp(ui.elements[element("schedule-0")].title, "Pasta") == 0);
  advance(25); assert(timer_progress() == 0);
  agent_capabilities_refresh_now(caps); assert(timer_progress() == 25);
  command(caps, "timer", "pause", "Pasta", ""); event(caps, "local.home");
  advance(10); assert(timer_progress() == 25);
  command(caps, "timer", "resume", "Pasta", ""); event(caps, "local.home");
  advance(25); agent_capabilities_refresh_now(caps); assert(timer_progress() == 50);
  advance(50); assert(timer_progress() == 100);
  event(caps, "local.schedule.0"); event(caps, "local.schedule.toggle");
  assert(element("schedule-0") < 0);
  command(caps, "timer", "start", "Long", "duration=7d show=false");
  assert(timer_progress() == 0);
  command(caps, "timer", "cancel", "Long", ""); assert(element("schedule-0") < 0);
  agent_capabilities_destroy(caps);
}

static void test_dashboard_destinations(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  const char *ids[] = { "calendar", "dashboard-summary", "dictate", "weather", "todos" };
  const char *actions[] = { "local.calendar", "local.dashboard.notifications", "local.dictate", "local.weather", "local.todos" };
  for (unsigned i = 0; i < 5; ++i) {
    int index = element(ids[i]); assert(index >= 0);
    assert(strcmp(ui.elements[index].action, actions[i]) == 0);
  }
  event(caps, "local.calendar"); assert(strcmp(ui.screen, "calendar") == 0);
  assert(strstr(ui.elements[element("placeholder")].value, "coming soon"));
  event(caps, "local.home");
  event(caps, "local.todos"); assert(strcmp(ui.screen, "todos") == 0);
  event(caps, "local.home");
  event(caps, "local.dashboard.notifications"); assert(strcmp(ui.screen, "notifications") == 0);
  assert(element("all-clear") >= 0);
  command(caps, "timer", "start", "tea", "duration=60s show=false");
  assert(strcmp(ui.screen, "notifications") == 0 && element("schedule-0") >= 0);
  advance(2); agent_capabilities_refresh_now(caps); assert(strstr(ui.elements[element("schedule-0")].subtitle, "00:58"));
  event(caps, "local.home"); assert(strcmp(ui.screen, "dashboard") == 0);
  event(caps, "local.dashboard.notifications");
  event(caps, "local.schedule.0"); assert(strcmp(ui.screen, "tea") == 0);
  agent_capabilities_destroy(caps);
}

static void test_multiple_and_ack(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL); assert(caps);
  command(caps, "timer", "start", "tea", "duration=5s");
  command(caps, "timer", "start", "eggs", "duration=8s");
  command(caps, "alarm", "schedule", "alarm", "in=5s");
  event(caps, "local.home");
  assert(element("schedule-0") >= 0 && element("schedule-1") >= 0 && element("schedule-4") >= 0);
  assert(wake_at == now + 5);
  uint32_t revision = agent_capabilities_notification_revision(caps);
  uint32_t navigation = agent_capabilities_navigation_revision(caps);
  advance(5);
  assert(strcmp(ui.screen, "notifications") == 0 && element("notifications") >= 0);
  assert(agent_capabilities_notification_revision(caps) > revision);
  assert(agent_capabilities_navigation_revision(caps) == navigation);
  assert(strstr(ui.elements[element("schedule-0")].subtitle, "Finished"));
  assert(buzzes == 1);
  advance(6); assert(buzzes >= 3);
  event(caps, "local.schedule.0"); event(caps, "local.schedule.toggle");
  assert(element("schedule-0") < 0 && element("schedule-1") >= 0);
  int before = buzzes; advance(3); assert(buzzes > before);
  event(caps, "local.schedule.1"); event(caps, "local.schedule.toggle");
  event(caps, "local.schedule.4"); event(caps, "local.schedule.toggle");
  before = buzzes; advance(6); assert(buzzes == before && wake_id == -1);
  agent_capabilities_destroy(caps);
}
static void test_pause_cancel_restore(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  AgentCapabilityCommand first = { .type = "timer", .command = "start", .id = "one",
    .title = "one", .meta = "duration=30s", .invocation_id = 101 };
  assert(agent_capabilities_handle_command(caps, &first));
  command(caps, "timer", "start", "two", "duration=60s");
  WakeupId old_wake = wake_id;
  advance(5);
  assert(agent_capabilities_handle_command(caps, &first));
  assert(wake_at == 100030); // duplicate must not restart at 100035
  wake_handler(old_wake + 500, wake_cookie); // unrelated stale event
  assert(buzzes == 0);
  advance(5); command(caps, "timer", "pause", "one", "");
  event(caps, "local.home"); advance(5);
  assert(strstr(ui.elements[element("schedule-0")].subtitle, "00:20"));
  command(caps, "timer", "cancel", "two", "");
  assert(element("schedule-1") < 0 && wake_id == -1);
  agent_capabilities_destroy(caps);
  caps = agent_capabilities_create(&ui, NULL, NULL);
  assert(element("schedule-0") >= 0 && strstr(ui.elements[element("schedule-0")].subtitle, "Paused"));
  command(caps, "timer", "resume", "one", "");
  agent_capabilities_destroy(caps); now += 25;
  caps = agent_capabilities_create(&ui, NULL, NULL);
  assert(element("notifications") >= 0);
  event(caps, "local.schedule.0"); event(caps, "local.schedule.snooze");
  assert(element("notifications") < 0 && wake_at == now + 600);
  agent_capabilities_destroy(caps);
}
static void test_failures_and_capacity(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  for (int i = 0; i < 4; ++i) { char id[8]; snprintf(id, sizeof(id), "t%d", i); command(caps, "timer", "start", id, "duration=30s"); }
  command(caps, "timer", "start", "fifth", "duration=30s"); assert(strstr(ui.status, "Four timers"));
  command(caps, "timer", "cancel_all", "", "");
  writes_fail = 1; command(caps, "timer", "start", "lost", "duration=5s");
  writes_fail = 0; event(caps, "local.home"); assert(element("schedule-0") < 0);
  wake_fail = true; command(caps, "timer", "start", "live", "duration=5s"); assert(strstr(ui.status, "keep codey open"));
  advance(5); assert(element("notifications") >= 0 && buzzes > 0);
  wake_fail = false; command(caps, "timer", "cancel_all", "", "");
  command(caps, "timer", "start", "bad", "duration=2147483648s"); assert(strstr(ui.status, "duration"));
  now = INT32_MAX - 3; command(caps, "alarm", "schedule", "overflow", "in=5s"); assert(strstr(ui.status, "duration"));
  agent_capabilities_destroy(caps);
  memset(storage[4200].data, 0xff, storage[4200].size);
  caps = agent_capabilities_create(&ui, NULL, NULL); assert(element("schedule-0") < 0);
  agent_capabilities_destroy(caps);
}

static void test_explicit_replacement(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  command(caps, "timer", "start", "tea", "duration=5s");
  WakeupId original = wake_id;
  AgentCapabilityCommand replace = { .type = "timer", .command = "start", .id = "tea",
    .title = "Tea", .meta = "duration=30s", .flags = 32 };
  assert(agent_capabilities_handle_command(caps, &replace));
  wake_handler(original, wake_cookie);
  advance(6);
  event(caps, "local.home");
  assert(buzzes == 0 && element("notifications") < 0);
  assert(strstr(ui.elements[element("schedule-0")].subtitle, "00:24"));
  agent_capabilities_destroy(caps);
}
static void test_stopwatch_dashboard(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  command(caps, "stopwatch", "start", "run", ""); event(caps, "local.home"); advance(5);
  assert(timer_callbacks == 0);
  agent_capabilities_refresh_now(caps);
  assert(strstr(ui.elements[element("dashboard-stopwatch")].subtitle, "00:05"));
  assert(strcmp(ui.screen, "dashboard") == 0);
  event(caps, "local.stopwatch"); assert(strcmp(ui.screen, "run") == 0);
  agent_capabilities_destroy(caps);
}
static void test_reused_ids_and_screen_independent_expiry(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  AgentCapabilityCommand first = { .type = "timer", .command = "start", .id = "timer",
    .title = "10 seconds", .meta = "duration=10s", .invocation_id = 201 };
  AgentCapabilityCommand second = { .type = "timer", .command = "start", .id = "timer",
    .title = "60 seconds", .meta = "duration=60s", .invocation_id = 202 };
  assert(agent_capabilities_handle_command(caps, &first));
  assert(agent_capabilities_handle_command(caps, &second));
  assert(strcmp(ui.screen, "timer-1") == 0);
  advance(10); // Expire the FIRST timer while viewing the SECOND timer.
  assert(buzzes > 0 && strcmp(ui.screen, "notifications") == 0);
  assert(strstr(ui.elements[element("schedule-0")].subtitle, "Finished"));
  assert(strstr(ui.elements[element("schedule-1")].subtitle, "00:50"));
  event(caps, "local.schedule.1");
  int before = buzzes; advance(3); assert(buzzes > before); // buzz on other detail screen
  event(caps, "local.schedule.cancel");
  assert(element("schedule-1") < 0 && element("schedule-0") >= 0); // cancel correct collision ID
  event(caps, "local.schedule.0"); event(caps, "local.schedule.toggle");
  assert(agent_capabilities_handle_command(caps, &first)); // canceled/acked replay never resurrects
  assert(element("schedule-0") < 0);
  assert(agent_capabilities_handle_command(caps, &second));
  assert(element("schedule-1") < 0);
  agent_capabilities_destroy(caps);

  const char *screens[] = { "dashboard", "remote", "stopwatch", "schedules" };
  for (unsigned i = 0; i < sizeof(screens) / sizeof(screens[0]); ++i) {
    reset(); caps = agent_capabilities_create(&ui, NULL, NULL);
    command(caps, "alarm", "schedule", "alarm", "in=5s");
    command(caps, "alarm", "schedule", "alarm", "in=30s"); // same-name alarms too
    agent_capabilities_set_active(caps, screens[i], true);
    agent_ui_begin(&ui, screens[i], "card", "Other screen", "", "", 16);
    advance(5);
    assert(buzzes > 0 && strcmp(ui.screen, "notifications") == 0);
    assert(element("schedule-4") >= 0 && element("schedule-5") >= 0);
    event(caps, "local.schedule.4"); event(caps, "local.schedule.toggle");
    agent_capabilities_set_active(caps, "remote", true);
    advance(25);
    assert(element("notifications") >= 0 && element("schedule-5") >= 0);
    agent_capabilities_destroy(caps);
  }
}
static void test_delivery_replay_after_relaunch(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  AgentCapabilityCommand cmd = { .type = "timer", .command = "start", .id = "timer",
    .title = "Timer", .meta = "duration=60s", .invocation_id = 999 };
  assert(agent_capabilities_handle_command(caps, &cmd));
  agent_capabilities_destroy(caps); now += 10;
  caps = agent_capabilities_create(&ui, NULL, NULL);
  assert(agent_capabilities_handle_command(caps, &cmd));
  event(caps, "local.home");
  assert(element("schedule-0") >= 0 && element("schedule-1") < 0);
  assert(strstr(ui.elements[element("schedule-0")].subtitle, "00:50"));
  agent_capabilities_destroy(caps);
}

static char job_event[24], job_id[32];
static void job_event_handler(const char *type,const char *id,const char *action,const char *value,void *context) {
  (void)value; (void)context;
  if (!strcmp(type,"job")) { agent_protocol_copy(job_event,sizeof(job_event),action); agent_protocol_copy(job_id,sizeof(job_id),id); }
}
static void test_jobs(void) {
  reset(); AgentCapabilities *caps=agent_capabilities_create(&ui,job_event_handler,NULL);
  AgentCapabilityCommand cmd={.type="job",.command="upsert",.id="123456789012345678901234567890",.title="Find gift cards",.subtitle="working",.value="",.meta=""};
  assert(agent_capabilities_handle_command(caps,&cmd)); assert(!strcmp(ui.screen,"dashboard"));
  int saved_writes = writes;
  assert(agent_capabilities_handle_command(caps,&cmd)); assert(writes == saved_writes);
  event(caps,"local.dashboard.notifications"); assert(element(cmd.id)>=0);
  assert(!strcmp(ui.elements[element(cmd.id)].subtitle,"Checking…"));assert(!strcmp(job_event,"refresh"));
  agent_capabilities_rebuild_dashboard(caps); assert(!strcmp(ui.elements[element(cmd.id)].subtitle,"Checking…"));
  assert(agent_capabilities_handle_command(caps,&cmd)); assert(!strcmp(ui.elements[element(cmd.id)].subtitle,"working"));
  event(caps,"local.home");event(caps,"local.dashboard.notifications");
  advance(23);assert(!strcmp(ui.elements[element(cmd.id)].subtitle,"Check unavailable"));
  assert(agent_capabilities_handle_command(caps,&cmd));

  AgentUiEvent tap={.action="local.job.open"}; agent_protocol_copy(tap.element_id,sizeof(tap.element_id),cmd.id);
  assert(agent_capabilities_handle_ui_event(caps,&tap)); assert(!strcmp(ui.screen,"job-status")); assert(!strcmp(job_event,"check")); assert(!strcmp(job_id,cmd.id));
  assert(element("cancel-job")>=0); assert(!strcmp(ui.elements[element("job-state")].value,"Checking…"));
  assert(agent_capabilities_handle_command(caps,&cmd)); assert(!strcmp(ui.elements[element("job-state")].value,"working"));
  event(caps,"local.job.cancel"); assert(!strcmp(job_event,"cancel"));
  cmd.subtitle="canceled";cmd.value="Work already performed is not undone";
  assert(agent_capabilities_handle_command(caps,&cmd)); assert(element("cancel-job")<0);assert(element("dismiss-job")>=0);
  agent_capabilities_destroy(caps); caps=agent_capabilities_create(&ui,job_event_handler,NULL);
  assert(element(cmd.id)>=0);assert(!strcmp(ui.elements[element(cmd.id)].subtitle,"canceled"));
  assert(agent_capabilities_handle_ui_event(caps,&tap)); event(caps,"local.job.dismiss");assert(!strcmp(job_event,"dismiss"));
  cmd.command="remove";assert(agent_capabilities_handle_command(caps,&cmd));assert(element(cmd.id)<0);
  agent_capabilities_destroy(caps);
}


static void test_checkbox_double_tap(void) {
  reset();AgentCapabilities *caps=agent_capabilities_create(&ui,todo_event,NULL);todo_action[0]=0;int before=writes;
  TouchGuard guard={0};assert(!touch_guard_down(&guard,1,12,50,100));assert(!touch_guard_up(&guard,1,12,50,150));assert(!todo_action[0]);
  assert(touch_guard_down(&guard,1,12,50,250));if(touch_guard_up(&guard,1,12,50,300))event(caps,"local.todo.complete");
  assert(!strcmp(todo_action,"complete"));assert(writes==before);agent_capabilities_destroy(caps);
}
static char note_action[24], note_id[32], note_value[220];
static void note_event(const char *type,const char *id,const char *action,const char *value,void *context) {
  (void)context;if(strcmp(type,"note"))return;
  agent_protocol_copy(note_action,sizeof(note_action),action);agent_protocol_copy(note_id,sizeof(note_id),id);agent_protocol_copy(note_value,sizeof(note_value),value);
}
static void test_notes(void) {
  reset();AgentCapabilities *caps=agent_capabilities_create(&ui,note_event,NULL);
  int before=writes;event(caps,"local.notes");assert(!strcmp(note_action,"list"));
  assert(!strcmp(ui.screen,"notes-loading"));assert(writes==before+1); // Only the tile preference.
  before=writes;event(caps,"local.notes");assert(writes==before);
  AgentUiEvent open={.action="local.note.open",.element_id="phone-1"};
  assert(agent_capabilities_handle_ui_event(caps,&open));assert(!strcmp(note_action,"read") && !strcmp(note_id,"phone-1"));
  assert(!strcmp(note_value,"0"));assert(writes==before);
  AgentUiEvent page={.action="local.note.page",.value="2",.meta="note=phone-1"};
  assert(agent_capabilities_handle_ui_event(caps,&page));assert(!strcmp(note_id,"phone-1") && !strcmp(note_value,"2"));
  AgentCapabilityCommand edit={.type="note",.command="edit",.id="phone-1",.value="Replacement"};
  assert(agent_capabilities_handle_command(caps,&edit));assert(!strcmp(note_action,"edit"));assert(writes==before);
  agent_capabilities_destroy(caps);
}
static void test_idle_cadence(void) {
  reset(); AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  advance(59); assert(timer_callbacks == 0);
  advance(1); assert(timer_callbacks == 1);
  advance(120); assert(timer_callbacks == 3);
  agent_capabilities_destroy(caps);
  advance(120); assert(timer_callbacks == 3);
}
static void test_welcome_tour(void) {
  reset();
  AgentCapabilities *caps = agent_capabilities_create(&ui, NULL, NULL);
  assert(element("welcome") >= 0);
  event(caps, "local.dashboard.notifications");
  assert(element("welcome") >= 0);
  event(caps, "local.tour");
  assert(strcmp(ui.screen, "tour") == 0 && element("tour-dismiss") >= 0);
  event(caps, "local.home");
  agent_capabilities_destroy(caps);
  caps = agent_capabilities_create(&ui, NULL, NULL);
  assert(element("welcome") >= 0);
  event(caps, "local.tour");
  writes_fail = 1;
  event(caps, "local.tour.dismiss");
  assert(strcmp(ui.screen, "tour") == 0 && ui.status[0]);
  writes_fail = 0;
  event(caps, "local.tour.dismiss");
  assert(element("welcome") < 0);
  agent_capabilities_destroy(caps);
  caps = agent_capabilities_create(&ui, NULL, NULL);
  event(caps, "local.dashboard.notifications");
  assert(element("welcome") < 0);
  agent_capabilities_destroy(caps);
}

int main(void) {
  test_welcome_tour();
   test_checkbox_double_tap(); test_notes(); test_idle_cadence();
  test_weather_summary(); test_todos(); test_collection_previews(); test_dashboard_progress(); test_dashboard_destinations(); test_multiple_and_ack(); test_pause_cancel_restore(); test_failures_and_capacity(); test_stopwatch_dashboard();  test_explicit_replacement();
  test_reused_ids_and_screen_independent_expiry(); test_delivery_replay_after_relaunch();
   test_jobs();
  puts("✓ schedules: concurrent deadlines, repeated alerts, acknowledge, snooze, navigation, persistence, failures, bounds, stopwatch, jobs");
  return 0;
}
