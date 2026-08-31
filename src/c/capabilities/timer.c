#include "internal.h"

#include "../agent_protocol.h"

#include <stdlib.h>
#include <string.h>

#define TIMER_PERSIST_KEY 4100
#define TIMER_MAGIC 0x54494d52
#define TIMER_WAKE_COOKIE 0x54494d45

typedef struct {
  uint32_t magic;
  bool active;
  bool running;
  int32_t duration;
  int32_t remaining;
  time_t end_at;
  WakeupId wakeup_id;
  char id[AGENT_UI_ID_LENGTH];
  char title[AGENT_UI_TITLE_LENGTH];
} TimerPersisted;

typedef struct {
  TimerPersisted state;
  AppTimer *tick_timer;
  AgentCapabilities *capabilities;
} TimerModule;

static void prv_save(TimerModule *timer) {
  persist_write_data(TIMER_PERSIST_KEY, &timer->state, sizeof(timer->state));
}

static int32_t prv_remaining(TimerModule *timer) {
  if (!timer->state.active) { return 0; }
  if (!timer->state.running) { return timer->state.remaining; }
  return (int32_t)AGENT_CAP_MAX(0, timer->state.end_at - time(NULL));
}

static void prv_cancel_wakeup(TimerModule *timer) {
  if (timer->state.wakeup_id >= 0) {
    wakeup_cancel(timer->state.wakeup_id);
    timer->state.wakeup_id = -1;
  }
}

static void prv_schedule_wakeup(TimerModule *timer) {
  prv_cancel_wakeup(timer);
  if (timer->state.running && timer->state.end_at > time(NULL)) {
    timer->state.wakeup_id = wakeup_schedule(timer->state.end_at, TIMER_WAKE_COOKIE, true);
  }
}

static void prv_render(TimerModule *timer) {
  AgentUi *ui = agent_capabilities_ui(timer->capabilities);
  char display[24];
  char progress[24];
  char progress_meta[64];
  int32_t remaining = prv_remaining(timer);
  agent_capability_format_duration(display, sizeof(display), remaining, timer->state.duration >= 3600);
  snprintf(progress, sizeof(progress), "%ld", (long)remaining);
  snprintf(progress_meta, sizeof(progress_meta), "min=0 max=%ld", (long)AGENT_CAP_MAX(1, timer->state.duration));
  agent_ui_begin(ui, timer->state.id, "progress", timer->state.title, "",
                 timer->state.active ? "actionbar=true" : "", 16);
  agent_capability_add_element(ui, "metric", "timer-display", "Remaining", "", display, "", "", 0);
  agent_capability_add_element(ui, "progress", "timer-progress", "", "", progress, "", progress_meta, 0);
  if (timer->state.active) {
    agent_capability_add_element(ui, "text", "timer-help", "", "",
                                 timer->state.running ? "Select pauses · Down cancels" :
                                                        "Select resumes · Down cancels",
                                 "", "", 0);
    agent_capability_add_element(ui, "bind", "timer-select",
                                 timer->state.running ? "Pause" : "Resume",
                                 "", "", "cap.timer.toggle", "input=select icon=check", 0);
    agent_capability_add_element(ui, "bind", "timer-down", "Cancel", "", "", "cap.timer.cancel",
                                 "input=down icon=warning", 0);
  } else {
    agent_capability_add_element(ui, "text", "timer-help", "", "", "Timer stopped", "", "", 0);
  }
  agent_ui_end(ui);
  agent_capabilities_set_active(timer->capabilities, "timer", true);
}

static void prv_tick(void *context);

static void prv_schedule_tick(TimerModule *timer) {
  if (!timer->tick_timer && timer->state.active && timer->state.running) {
    timer->tick_timer = app_timer_register(1000, prv_tick, timer);
  }
}

static void prv_finish(TimerModule *timer) {
  prv_cancel_wakeup(timer);
  timer->state.running = false;
  timer->state.active = false;
  timer->state.remaining = 0;
  prv_save(timer);
  prv_render(timer);
  agent_ui_set_status(agent_capabilities_ui(timer->capabilities), "Timer complete", false, false);
  vibes_double_pulse();
  agent_capabilities_emit(timer->capabilities, "timer", timer->state.id, "timer.finished", "0");
}

static void prv_tick(void *context) {
  TimerModule *timer = context;
  char display[24];
  char progress[24];
  int32_t remaining;
  timer->tick_timer = NULL;
  if (!timer->state.active || !timer->state.running) { return; }
  remaining = prv_remaining(timer);
  if (remaining <= 0) {
    prv_finish(timer);
    return;
  }
  timer->state.remaining = remaining;
  agent_capability_format_duration(display, sizeof(display), remaining, timer->state.duration >= 3600);
  snprintf(progress, sizeof(progress), "%ld", (long)remaining);
  agent_capability_patch_value(agent_capabilities_ui(timer->capabilities), "timer-display", display);
  agent_capability_patch_value(agent_capabilities_ui(timer->capabilities), "timer-progress", progress);
  prv_schedule_tick(timer);
}

static void prv_start(TimerModule *timer, const AgentCapabilityCommand *command) {
  char duration_value[32];
  int32_t duration;
  if (!agent_protocol_meta_get(command->meta, "duration", duration_value, sizeof(duration_value))) {
    agent_protocol_copy(duration_value, sizeof(duration_value), command->value);
  }
  duration = agent_capability_parse_duration(duration_value, 60);
  duration = AGENT_CAP_MAX(1, AGENT_CAP_MIN(duration, 7 * 86400));
  prv_cancel_wakeup(timer);
  if (timer->tick_timer) {
    app_timer_cancel(timer->tick_timer);
    timer->tick_timer = NULL;
  }
  memset(&timer->state, 0, sizeof(timer->state));
  timer->state.magic = TIMER_MAGIC;
  timer->state.active = true;
  timer->state.running = true;
  timer->state.duration = duration;
  timer->state.remaining = duration;
  timer->state.end_at = time(NULL) + duration;
  timer->state.wakeup_id = -1;
  agent_protocol_copy(timer->state.id, sizeof(timer->state.id), command->id && command->id[0] ? command->id : "timer");
  agent_protocol_copy(timer->state.title, sizeof(timer->state.title),
                      command->title && command->title[0] ? command->title : "Timer");
  prv_schedule_wakeup(timer);
  prv_save(timer);
  prv_render(timer);
  prv_schedule_tick(timer);
}

static bool prv_command(AgentCapabilities *capabilities, const AgentCapabilityCommand *command,
                        void *module_context) {
  TimerModule *timer = module_context;
  (void)capabilities;
  if (strcmp(command->command, "start") == 0 || strcmp(command->command, "set") == 0) {
    prv_start(timer, command);
  } else if (strcmp(command->command, "pause") == 0 && timer->state.active) {
    timer->state.remaining = prv_remaining(timer);
    timer->state.running = false;
    prv_cancel_wakeup(timer);
    prv_save(timer);
    prv_render(timer);
  } else if (strcmp(command->command, "resume") == 0 && timer->state.active) {
    timer->state.running = true;
    timer->state.end_at = time(NULL) + timer->state.remaining;
    prv_schedule_wakeup(timer);
    prv_save(timer);
    prv_render(timer);
    prv_schedule_tick(timer);
  } else if (strcmp(command->command, "cancel") == 0) {
    prv_cancel_wakeup(timer);
    timer->state.active = false;
    timer->state.running = false;
    prv_save(timer);
    prv_render(timer);
    agent_ui_set_status(agent_capabilities_ui(timer->capabilities), "Timer canceled", false, false);
  } else if (strcmp(command->command, "show") == 0 && timer->state.active) {
    prv_render(timer);
    prv_schedule_tick(timer);
  } else {
    return false;
  }
  return true;
}

static bool prv_event(AgentCapabilities *capabilities, const AgentUiEvent *event, void *module_context) {
  TimerModule *timer = module_context;
  if (strcmp(event->action, "cap.timer.toggle") == 0) {
    AgentCapabilityCommand command = {
      .type = "timer",
      .command = timer->state.running ? "pause" : "resume",
    };
    return prv_command(capabilities, &command, timer);
  }
  if (strcmp(event->action, "cap.timer.cancel") == 0) {
    AgentCapabilityCommand command = { .type = "timer", .command = "cancel" };
    prv_command(capabilities, &command, timer);
    agent_capabilities_emit(capabilities, "timer", timer->state.id, "timer.canceled", "0");
    return true;
  }
  return false;
}

static bool prv_wakeup(AgentCapabilities *capabilities, WakeupId wakeup_id, int32_t cookie,
                       void *module_context) {
  TimerModule *timer = module_context;
  (void)capabilities;
  if (cookie != TIMER_WAKE_COOKIE || !timer->state.active) { return false; }
  timer->state.wakeup_id = wakeup_id;
  prv_finish(timer);
  return true;
}

static void prv_destroy(void *module_context) {
  TimerModule *timer = module_context;
  if (timer->tick_timer) { app_timer_cancel(timer->tick_timer); }
  free(timer);
}

bool agent_timer_install(AgentCapabilities *capabilities) {
  TimerModule *timer = calloc(1, sizeof(TimerModule));
  WakeupId launch_id;
  int32_t launch_cookie;
  if (!timer) { return false; }
  timer->capabilities = capabilities;
  timer->state.wakeup_id = -1;
  if (persist_read_data(TIMER_PERSIST_KEY, &timer->state, sizeof(timer->state)) != sizeof(timer->state) ||
      timer->state.magic != TIMER_MAGIC) {
    memset(&timer->state, 0, sizeof(timer->state));
    timer->state.magic = TIMER_MAGIC;
    timer->state.wakeup_id = -1;
  }
  if (!agent_capabilities_register(capabilities, "timer", (AgentCapabilityModule) {
        .command = prv_command,
        .event = prv_event,
        .wakeup = prv_wakeup,
        .destroy = prv_destroy,
      }, timer)) {
    free(timer);
    return false;
  }
  if (timer->state.active) {
    if (timer->state.running && wakeup_get_launch_event(&launch_id, &launch_cookie) &&
        launch_cookie == TIMER_WAKE_COOKIE) {
      prv_finish(timer);
    } else if (timer->state.running && prv_remaining(timer) <= 0) {
      prv_finish(timer);
    } else {
      if (timer->state.running) { prv_schedule_wakeup(timer); }
      prv_save(timer);
      prv_render(timer);
      prv_schedule_tick(timer);
    }
  }
  return true;
}
