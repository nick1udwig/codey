#include "internal.h"
#include "../agent_protocol.h"

#include <limits.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#define SLOT_COUNT 8
#define TIMER_COUNT 4
#define STORE_BASE 4200
#define RECORD_MAGIC 0x53434833
#define WAKE_COOKIE 0x53434832

enum { Empty, Running, Paused, Due };
// One record per persistence key, below Pebble's 256-byte value limit.
typedef struct {
  uint32_t magic;
  uint8_t state;
  uint8_t reserved[3];
  int32_t duration;
  int32_t remaining;
  time_t at;
  char id[AGENT_UI_ID_LENGTH];
  char title[AGENT_UI_TITLE_LENGTH];
  char body[84];
  uint32_t invocation_id;
} Record;
typedef char RecordFitsPersistence[(sizeof(Record) <= 256) ? 1 : -1];

typedef struct {
  AgentCapabilities *capabilities;
  Record records[SLOT_COUNT];
  int visible;
  WakeupId wakeup;
  time_t wake_at;
  time_t last_buzz;
  time_t last_retry;
  bool schedule_failed;
  AppTimer *alert_timer;
} Schedules;

static void prv_tick(void *context);
static void prv_alert(void *context) { Schedules *s=context; s->alert_timer=NULL; prv_tick(s); }

static bool prv_timer(int slot) { return slot < TIMER_COUNT; }
static bool prv_pending(const Schedules *s) {
  for (int i = 0; i < SLOT_COUNT; ++i) { if (s->records[i].state == Due) { return true; } }
  return false;
}
static int32_t prv_remaining(const Record *r) {
  if (r->state == Paused) { return r->remaining; }
  int64_t value = (int64_t)r->at - time(NULL);
  return value <= 0 ? 0 : value > INT32_MAX ? INT32_MAX : (int32_t)value;
}
static bool prv_save(Schedules *s, int slot) {
  if (persist_write_data(STORE_BASE + slot, &s->records[slot], sizeof(Record)) == sizeof(Record)) {
    return true;
  }
  agent_ui_set_status(agent_capabilities_ui(s->capabilities), "Could not save alert", true, false);
  return false;
}
static bool prv_valid(const Record *r, int slot) {
  return r->magic == RECORD_MAGIC && r->state <= Due &&
         (prv_timer(slot) || r->state != Paused) &&
         memchr(r->id, 0, sizeof(r->id)) && memchr(r->title, 0, sizeof(r->title)) &&
         memchr(r->body, 0, sizeof(r->body)) &&
         (r->state == Empty || (r->id[0] && r->at >= 0 &&
          (!prv_timer(slot) || (r->duration > 0 && r->duration <= 7 * 86400 &&
                               r->remaining >= 0 && r->remaining <= r->duration))));
}
static void prv_schedule(Schedules *s) {
  time_t now = time(NULL);
  time_t next = 0;
  for (int i = 0; i < SLOT_COUNT; ++i) {
    Record *r = &s->records[i];
    if (r->state == Running && r->at > now && (!next || r->at < next)) { next = r->at; }
  }
  // If the app is closed with an unacknowledged notification, relaunch to alert
  // again. Foreground vibration is driven separately and never fills the queue.
  if (prv_pending(s) && now <= INT32_MAX - 60 && (!next || next > now + 60)) { next = now + 60; }
  if (s->wakeup >= 0 && s->wake_at > now &&
      (s->wake_at == next || (prv_pending(s) && s->wake_at < next))) { return; }
  if (s->wakeup >= 0) { wakeup_cancel(s->wakeup); }
  s->wakeup = -1;
  s->wake_at = 0;
  s->schedule_failed = false;
  if (next) {
    s->wakeup = wakeup_schedule(next, WAKE_COOKIE, true);
    if (s->wakeup >= 0) { s->wake_at = next; }
    else {
      s->schedule_failed = true;
      s->last_retry = now;
      agent_ui_set_status(agent_capabilities_ui(s->capabilities),
                          "Wakeup unavailable; keep codey open", true, false);
    }
  }
}
static void prv_when(Record *r, bool timer, char *value, size_t size) {
  if (r->state == Due) { agent_protocol_copy(value, size, "Finished · Open to acknowledge"); }
  else if (timer) {
    char remaining[24];
    agent_capability_format_duration(remaining, sizeof(remaining), prv_remaining(r), false);
    snprintf(value, size, "%s%s", remaining, r->state == Paused ? " · Paused" : " remaining");
  } else {
    struct tm *local = localtime(&r->at);
    if (local) { strftime(value, size, clock_is_24h_style() ? "%a %H:%M" : "%a %I:%M %p", local); }
    else { agent_protocol_copy(value, size, "Scheduled"); }
  }
}
static void prv_detail_value(Record *r, bool timer, char *value, size_t size) {
  if (r->state == Due) { agent_protocol_copy(value, size, timer ? "Timer complete" : "Alarm due"); }
  else if (timer) { agent_capability_format_duration(value, size, prv_remaining(r), false); }
  else { prv_when(r, false, value, size); }
}
static void prv_dashboard(AgentCapabilities *capabilities, void *context, bool refresh) {
  Schedules *s = context;
  AgentUi *ui = agent_capabilities_ui(capabilities);
  if (!refresh && s->schedule_failed) {
    agent_capability_add_element(ui, "text", "wakeup-warning", "", "",
                                 "Wakeup unavailable; keep codey open", "", "", 0);
  }
  int focus = -1;
  if (agent_capabilities_is_active(capabilities, "notifications")) {
    for (int i = 0; i < SLOT_COUNT; ++i) {
      if (s->records[i].state == Due &&
          (focus < 0 || s->records[i].at > s->records[focus].at)) { focus = i; }
    }
  }
  const char *headings[] = { "Notifications", "Timers", "Alarms & reminders" };
  const char *sections[] = { "notifications", "timers", "alarms" };
  for (int group = 0; group < 3; ++group) {
    int count = 0;
    for (int i = 0; i < SLOT_COUNT; ++i) {
      Record *r = &s->records[i];
      if (r->state == Empty || (r->state == Due ? 0 : prv_timer(i) ? 1 : 2) != group) { continue; }
      if (!count && !refresh) {
        agent_capability_add_element(ui, "section", sections[group], headings[group], "", "", "", "", 0);
      }
      ++count;
      char id[24], action[40], value[100], meta[80];
      snprintf(id, sizeof(id), "schedule-%d", i);
      snprintf(action, sizeof(action), "local.schedule.%d", i);
      prv_when(r, prv_timer(i), value, sizeof(value));
      int32_t progress = 0;
      if (r->state == Due) { progress = 100; }
      else if (prv_timer(i) && r->duration > 0) {
        int32_t remaining = prv_remaining(r);
        if (remaining > r->duration) { remaining = r->duration; }
        progress = (int32_t)((int64_t)(r->duration - remaining) * 100 / r->duration);
      }
      snprintf(meta, sizeof(meta), "dashboard_kind=%s progress=%ld",
               prv_timer(i) ? "timer" : "alarm", (long)progress);
      if (refresh) {
        agent_ui_patch(ui, &(AgentUiElementSpec) {
          .id = id, .subtitle = value, .meta = meta,
          .present = AgentUiPresentSubtitle | AgentUiPresentMeta,
        });
      } else {
        agent_capability_add_element(ui, "item", id, r->title, value, "", action, meta, i == focus ? 64 : 0);
      }
    }
    if (!count && group == 0 && !refresh) {
      agent_capability_add_element(ui, "text", "all-clear", "", "", "No notifications", "", "", 0);
    }
  }
}
static void prv_render(Schedules *s, int slot) {
  Record *r = &s->records[slot];
  AgentUi *ui = agent_capabilities_ui(s->capabilities);
  char value[100];
  s->visible = slot;
  agent_capabilities_set_active(s->capabilities, "schedules", true);
  prv_detail_value(r, prv_timer(slot), value, sizeof(value));
  agent_ui_begin(ui, r->id, "card", r->title, "", "actionbar=true", 16);
  agent_capability_add_element(ui, "metric", "schedule-value", prv_timer(slot) ? "Timer" : "Alarm",
                               "", value, "", "", 0);
  if (r->body[0]) { agent_capability_add_element(ui, "text", "schedule-body", "", "", r->body, "", "", 0); }
  const char *select = r->state == Due ? "Acknowledge" : r->state == Paused ? "Resume" : "Pause";
  if (prv_timer(slot) || r->state == Due) {
    agent_capability_add_element(ui, "bind", "schedule-select", select, "", "", "local.schedule.toggle",
                                 "input=select icon=check", 0);
  }
  agent_capability_add_element(ui, "bind", "schedule-cancel", r->state == Due ? "Snooze 10m" : "Cancel",
                               "", "", r->state == Due ? "local.schedule.snooze" : "local.schedule.cancel",
                               r->state == Due ? "input=down icon=timer" : "input=down icon=close", 0);
  agent_capability_add_element(ui, "bind", "schedule-home", "Back", "", "", "local.home", "input=up icon=left", 0);
  agent_capability_add_element(ui, "text", "schedule-help", "", "",
                               r->state == Due ? "Select acknowledges · Down snoozes" :
                               "Back keeps running · X cancels", "", "", 0);
  agent_ui_end(ui);
}
static void prv_tick(void *context) {
  Schedules *s = context;
  time_t now = time(NULL);
  bool changed = false;
  for (int i = 0; i < SLOT_COUNT; ++i) {
    Record *r = &s->records[i];
    if (r->state == Running && r->at <= now) {
      r->state = Due;
      r->remaining = 0;
      prv_save(s, i);
      changed = true;
      // Completion belongs to the local notification center. It must not start
      // an unsolicited model turn that overwrites the alert or restarts a timer.
    }
  }
  if (changed) { agent_capabilities_show_notifications(s->capabilities); }
  if (prv_pending(s)) {
    if (!s->last_buzz || (int64_t)now - s->last_buzz >= 3 || now < s->last_buzz) {
      vibes_double_pulse();
      s->last_buzz = now;
    }
  } else if (s->last_buzz) {
    vibes_cancel();
    s->last_buzz = 0;
  }
  if (changed || (s->wakeup >= 0 && s->wake_at <= now) ||
      (s->schedule_failed && (int64_t)now - s->last_retry >= 30)) { prv_schedule(s); }
  // Wakeups deliver exact deadlines; only active alerts or a failed wakeup
  // need a short foreground timer. An idle scheduler has no polling timer.
  if(s->alert_timer){app_timer_cancel(s->alert_timer);s->alert_timer=NULL;}
  uint32_t delay=prv_pending(s)?3000:0;
  if(s->schedule_failed){
    time_t next=now+30;
    for(int i=0;i<SLOT_COUNT;++i)if(s->records[i].state==Running && s->records[i].at<next)next=s->records[i].at;
    uint32_t retry=(uint32_t)AGENT_CAP_MAX(1,next-now)*1000;
    if(!delay||retry<delay)delay=retry;
  }
  if(delay)s->alert_timer=app_timer_register(delay,prv_alert,s);
  if (agent_capabilities_is_active(s->capabilities, "schedules") && s->visible >= 0) {
    char value[100];
    prv_detail_value(&s->records[s->visible], prv_timer(s->visible), value, sizeof(value));
    agent_capability_patch_value(agent_capabilities_ui(s->capabilities), "schedule-value", value);
  }
}
static bool prv_commit(Schedules *s, int slot, Record next) {
  Record old = s->records[slot];
  s->records[slot] = next;
  if (!prv_save(s, slot)) { s->records[slot] = old; return false; }
  prv_schedule(s);
  return true;
}
static int prv_find(Schedules *s, bool timer, const char *id) {
  if (!id || !id[0]) { return -1; }
  for (int i = timer ? 0 : TIMER_COUNT; i < (timer ? TIMER_COUNT : SLOT_COUNT); ++i) {
    if (s->records[i].state != Empty && strcmp(s->records[i].id, id) == 0) { return i; }
  }
  return -1;
}
static int prv_free(Schedules *s, bool timer) {
  for (int i = timer ? 0 : TIMER_COUNT; i < (timer ? TIMER_COUNT : SLOT_COUNT); ++i) {
    if (s->records[i].state == Empty) { return i; }
  }
  return -1;
}
static bool prv_command(AgentCapabilities *capabilities, const AgentCapabilityCommand *cmd, void *context) {
  Schedules *s = context;
  bool timer = strcmp(cmd->type, "timer") == 0;
  bool create = strcmp(cmd->command, "start") == 0 || strcmp(cmd->command, "set") == 0 ||
                strcmp(cmd->command, "create") == 0 || strcmp(cmd->command, "schedule") == 0;
  int slot = prv_find(s, timer, cmd->id);
  if (strcmp(cmd->command, "list") == 0) {
    AgentUiEvent event = { .action = "local.dashboard.notifications" };
    agent_capabilities_handle_ui_event(capabilities, &event);
    return true;
  }
  if (strcmp(cmd->command, "cancel_all") == 0) {
    bool ok = true;
    for (int i = timer ? 0 : TIMER_COUNT; i < (timer ? TIMER_COUNT : SLOT_COUNT); ++i) {
      Record next = s->records[i]; next.state = Empty;
      if (!prv_commit(s, i, next)) { ok = false; }
    }
    agent_capabilities_show_dashboard(capabilities); prv_tick(s); return ok;
  }
  if (create) {
    // Only the delivery identity identifies a retry. A model may reuse the
    // same semantic ID in two genuinely different creation commands.
    if (cmd->invocation_id) {
      for (int i = timer ? 0 : TIMER_COUNT; i < (timer ? TIMER_COUNT : SLOT_COUNT); ++i) {
        if (s->records[i].invocation_id == cmd->invocation_id) {
          // Even an acknowledged/canceled command must not be resurrected.
          if (s->records[i].state != Empty && agent_protocol_meta_get_bool(cmd->meta,"show",true)) { prv_render(s, i); }
          return true;
        }
      }
    }
    bool collision = slot >= 0 && !(cmd->flags & 32) &&
                     !agent_protocol_meta_get_bool(cmd->meta, "replace", false);
    if (collision) { slot = -1; }
    if (slot < 0) { slot = prv_free(s, timer); }
    if (slot < 0) {
      agent_ui_set_status(agent_capabilities_ui(capabilities),
                          timer ? "Four timers already set" : "Four alarms already set", true, false);
      return true;
    }
    Record next = { .magic = RECORD_MAGIC, .state = Running };
    next.invocation_id = cmd->invocation_id;
    char value[40];
    int32_t seconds = 0, timestamp = 0;
    time_t now = time(NULL);
    if (!timer && agent_protocol_meta_get(cmd->meta, "at", value, sizeof(value))) {
      if (!agent_protocol_parse_int32(value, NULL, &timestamp)) { timestamp = 0; }
      next.at = timestamp;
    } else {
      if (!agent_protocol_meta_get(cmd->meta, timer ? "duration" : "in", value, sizeof(value))) {
        agent_protocol_copy(value, sizeof(value), cmd->value);
      }
      seconds = agent_capability_parse_duration(value, -1);
      if (seconds <= 0 || seconds > 7 * 86400 || now < 0 || (int64_t)now + seconds > INT32_MAX) {
        agent_ui_set_status(agent_capabilities_ui(capabilities), "Use a duration from 1s to 7d", true, false);
        return true;
      }
      next.at = now + seconds;
    }
    if (next.at <= now) {
      agent_ui_set_status(agent_capabilities_ui(capabilities), "Alarm time must be future", true, false);
      return true;
    }
    next.duration = next.remaining = seconds;
    if (cmd->id && strlen(cmd->id) >= sizeof(next.id)) { return false; }
    if (cmd->id && cmd->id[0]) { agent_protocol_copy(next.id, sizeof(next.id), cmd->id); }
    else { snprintf(next.id, sizeof(next.id), "%s-%d", timer ? "timer" : "alarm", slot); }
    if (collision || (prv_find(s, timer, next.id) >= 0 && !(cmd->flags & 32) &&
        !agent_protocol_meta_get_bool(cmd->meta, "replace", false))) {
      // Keep IDs unambiguous for local pause/cancel controls, including long
      // model IDs and IDs that already have a numeric suffix.
      char base[AGENT_UI_ID_LENGTH];
      agent_protocol_copy(base, sizeof(base), next.id);
      for (unsigned suffix = 1; suffix <= SLOT_COUNT + 1; ++suffix) {
        snprintf(next.id, sizeof(next.id), "%.24s-%u", base, suffix);
        if (prv_find(s, timer, next.id) < 0) { break; }
      }
    }
    agent_protocol_copy(next.title, sizeof(next.title), cmd->title && cmd->title[0] ? cmd->title : timer ? "Timer" : "Alarm");
    agent_protocol_copy(next.body, sizeof(next.body), cmd->subtitle);
    if (!prv_commit(s, slot, next)) { return true; }
    if (agent_protocol_meta_get_bool(cmd->meta, "show", true)) { prv_render(s, slot); }
    else if (agent_capabilities_is_active(capabilities, "dashboard") ||
             agent_capabilities_is_active(capabilities, "notifications")) { agent_capabilities_rebuild_dashboard(capabilities); }
  } else {
    if (slot < 0) { return false; }
    Record next = s->records[slot];
    if (strcmp(cmd->command, "show") == 0) { prv_render(s, slot); return true; }
    if (strcmp(cmd->command, "cancel") == 0 || strcmp(cmd->command, "ack") == 0) { next.state = Empty; }
    else if (timer && strcmp(cmd->command, "pause") == 0 && next.state == Running) {
      next.remaining = prv_remaining(&next); next.state = next.remaining ? Paused : Due;
    } else if (timer && strcmp(cmd->command, "resume") == 0 && next.state == Paused) {
      if ((int64_t)time(NULL) + next.remaining > INT32_MAX) { return false; }
      next.at = time(NULL) + next.remaining; next.state = Running;
    } else { return false; }
    if (!prv_commit(s, slot, next)) { return true; }
    if (next.state == Empty) { agent_capabilities_show_dashboard(capabilities); }
    else { prv_render(s, slot); }
  }
  prv_tick(s);
  if (s->schedule_failed) {
    agent_ui_set_status(agent_capabilities_ui(capabilities), "Wakeup unavailable; keep codey open", true, false);
  }
  return true;
}
static bool prv_event(AgentCapabilities *capabilities, const AgentUiEvent *event, void *context) {
  Schedules *s = context;
  const char *action = event->action;
  if (strncmp(action, "local.schedule.", 15) != 0) { return false; }
  int32_t slot;
  if (agent_protocol_parse_int32(action + 15, NULL, &slot)) {
    if (slot >= 0 && slot < SLOT_COUNT && s->records[slot].state != Empty) { prv_render(s, slot); }
    return true;
  }
  slot = s->visible;
  if (!agent_capabilities_is_active(capabilities, "schedules") || slot < 0 || slot >= SLOT_COUNT) { return true; }
  Record next = s->records[slot];
  if (strcmp(action, "local.schedule.snooze") == 0 && next.state == Due) {
    if ((int64_t)time(NULL) + 600 > INT32_MAX) { return true; }
    next.at = time(NULL) + 600;
    next.state = Running;
    if (prv_timer(slot)) { next.duration = next.remaining = 600; }
    if (prv_commit(s, slot, next)) { agent_capabilities_show_dashboard(capabilities); }
    prv_tick(s); return true;
  }
  const char *command = NULL;
  if (strcmp(action, "local.schedule.cancel") == 0) { command = "cancel"; }
  if (strcmp(action, "local.schedule.toggle") == 0) {
    command = next.state == Due ? "ack" : next.state == Paused ? "resume" : "pause";
  }
  if (command) {
    AgentCapabilityCommand cmd = { .type = prv_timer(slot) ? "timer" : "reminder", .command = command, .id = next.id };
    prv_command(capabilities, &cmd, s);
  }
  return true;
}
static bool prv_wakeup(AgentCapabilities *capabilities, WakeupId id, int32_t cookie, void *context) {
  Schedules *s = context;
  (void)capabilities;
  if (cookie != WAKE_COOKIE || id != s->wakeup) { return false; }
  s->wakeup = -1; s->wake_at = 0;
  prv_tick(s);
  prv_schedule(s);
  return true;
}
static void prv_destroy(void *context) {
  Schedules *s = context;
  if(s->alert_timer)app_timer_cancel(s->alert_timer);
  // Leave the earliest scheduled wakeup registered while the process is closed.
  vibes_cancel();
  free(s);
}
bool agent_schedules_install(AgentCapabilities *capabilities) {
  Schedules *s = calloc(1, sizeof(*s));
  if (!s) { return false; }
  s->capabilities = capabilities; s->visible = -1; s->wakeup = -1;
  for (int i = 0; i < SLOT_COUNT; ++i) {
    Record *r = &s->records[i];
    if (persist_read_data(STORE_BASE + i, r, sizeof(*r)) != sizeof(*r) || !prv_valid(r, i)) {
      memset(r, 0, sizeof(*r)); r->magic = RECORD_MAGIC;
    }
  }
  // Rebuild the single earliest-deadline wakeup from current records.
  wakeup_cancel_all();
  if (!agent_capabilities_register(capabilities, "timer", (AgentCapabilityModule) {
    .command = prv_command, .event = prv_event, .wakeup = prv_wakeup, .destroy = prv_destroy,
    .tick = prv_tick, .dashboard = prv_dashboard,
  }, s)) { free(s); return false; }
  if (!agent_capabilities_register(capabilities, "reminder", (AgentCapabilityModule) { .command = prv_command }, s) ||
      !agent_capabilities_register(capabilities, "alarm", (AgentCapabilityModule) { .command = prv_command }, s)) { return false; }
  prv_tick(s);
  prv_schedule(s);
  return true;
}
