#include "internal.h"

#include "../agent_protocol.h"

#include <stdlib.h>
#include <string.h>

#define STOPWATCH_PERSIST_KEY 4110
#define STOPWATCH_MAGIC 0x53545743

typedef struct {
  uint32_t magic;
  bool active;
  bool running;
  int32_t elapsed;
  time_t started_at;
  char id[AGENT_UI_ID_LENGTH];
  char title[AGENT_UI_TITLE_LENGTH];
} StopwatchPersisted;

typedef struct {
  StopwatchPersisted state;
  AppTimer *tick_timer;
  AgentCapabilities *capabilities;
} StopwatchModule;

static int32_t prv_elapsed(StopwatchModule *stopwatch) {
  int32_t elapsed = stopwatch->state.elapsed;
  if (stopwatch->state.running) {
    elapsed += (int32_t)AGENT_CAP_MAX(0, time(NULL) - stopwatch->state.started_at);
  }
  return elapsed;
}

static void prv_save(StopwatchModule *stopwatch) {
  persist_write_data(STOPWATCH_PERSIST_KEY, &stopwatch->state, sizeof(stopwatch->state));
}

static void prv_render(StopwatchModule *stopwatch) {
  AgentUi *ui = agent_capabilities_ui(stopwatch->capabilities);
  char display[24];
  char seconds[16];
  int32_t elapsed = prv_elapsed(stopwatch);
  agent_capability_format_duration(display, sizeof(display), elapsed, elapsed >= 3600);
  snprintf(seconds, sizeof(seconds), "%ld", (long)(elapsed % 60));
  agent_ui_begin(ui, stopwatch->state.id, "card", stopwatch->state.title, "", "actionbar=true", 16);
  agent_capability_add_element(ui, "metric", "stopwatch-display", "Elapsed", "", display, "", "", 0);
  agent_capability_add_element(ui, "progress", "stopwatch-progress", "Minute", "", seconds, "",
                               "min=0 max=60", 0);
  agent_capability_add_element(ui, "text", "stopwatch-help", "", "",
                               stopwatch->state.running ? "Select pauses · Down resets" :
                                                          "Select starts · Down resets",
                               "", "", 0);
  agent_capability_add_element(ui, "bind", "stopwatch-select",
                               stopwatch->state.running ? "Pause" : "Start", "", "",
                               "cap.stopwatch.toggle", "input=select icon=check", 0);
  agent_capability_add_element(ui, "bind", "stopwatch-down", "Reset", "", "",
                               "cap.stopwatch.reset", "input=down icon=warning", 0);
  agent_ui_end(ui);
  agent_capabilities_set_active(stopwatch->capabilities, "stopwatch", true);
}

static void prv_tick(void *context);

static void prv_schedule_tick(StopwatchModule *stopwatch) {
  if (!stopwatch->tick_timer && stopwatch->state.running) {
    stopwatch->tick_timer = app_timer_register(1000, prv_tick, stopwatch);
  }
}

static void prv_tick(void *context) {
  StopwatchModule *stopwatch = context;
  char display[24];
  char seconds[16];
  int32_t elapsed;
  stopwatch->tick_timer = NULL;
  if (!stopwatch->state.running) { return; }
  elapsed = prv_elapsed(stopwatch);
  agent_capability_format_duration(display, sizeof(display), elapsed, elapsed >= 3600);
  snprintf(seconds, sizeof(seconds), "%ld", (long)(elapsed % 60));
  agent_capability_patch_value(agent_capabilities_ui(stopwatch->capabilities), "stopwatch-display", display);
  agent_capability_patch_value(agent_capabilities_ui(stopwatch->capabilities), "stopwatch-progress", seconds);
  prv_schedule_tick(stopwatch);
}

static void prv_start(StopwatchModule *stopwatch, const AgentCapabilityCommand *command, bool reset) {
  if (reset || !stopwatch->state.active) {
    memset(&stopwatch->state, 0, sizeof(stopwatch->state));
    stopwatch->state.magic = STOPWATCH_MAGIC;
    stopwatch->state.active = true;
    agent_protocol_copy(stopwatch->state.id, sizeof(stopwatch->state.id),
                        command->id && command->id[0] ? command->id : "stopwatch");
    agent_protocol_copy(stopwatch->state.title, sizeof(stopwatch->state.title),
                        command->title && command->title[0] ? command->title : "Stopwatch");
  }
  if (!stopwatch->state.running) {
    stopwatch->state.running = true;
    stopwatch->state.started_at = time(NULL);
  }
  prv_save(stopwatch);
  prv_render(stopwatch);
  prv_schedule_tick(stopwatch);
}

static bool prv_command(AgentCapabilities *capabilities, const AgentCapabilityCommand *command,
                        void *module_context) {
  StopwatchModule *stopwatch = module_context;
  (void)capabilities;
  if (strcmp(command->command, "start") == 0) {
    prv_start(stopwatch, command, false);
  } else if ((strcmp(command->command, "pause") == 0 || strcmp(command->command, "stop") == 0) &&
             stopwatch->state.active) {
    stopwatch->state.elapsed = prv_elapsed(stopwatch);
    stopwatch->state.running = false;
    prv_save(stopwatch);
    prv_render(stopwatch);
  } else if (strcmp(command->command, "resume") == 0 && stopwatch->state.active) {
    prv_start(stopwatch, command, false);
  } else if (strcmp(command->command, "reset") == 0) {
    bool was_running = stopwatch->state.running;
    stopwatch->state.active = true;
    stopwatch->state.elapsed = 0;
    stopwatch->state.running = was_running;
    stopwatch->state.started_at = time(NULL);
    if (!stopwatch->state.id[0]) {
      agent_protocol_copy(stopwatch->state.id, sizeof(stopwatch->state.id), "stopwatch");
      agent_protocol_copy(stopwatch->state.title, sizeof(stopwatch->state.title), "Stopwatch");
    }
    prv_save(stopwatch);
    prv_render(stopwatch);
    prv_schedule_tick(stopwatch);
  } else if (strcmp(command->command, "lap") == 0 && stopwatch->state.active) {
    char value[24];
    agent_capability_format_duration(value, sizeof(value), prv_elapsed(stopwatch), false);
    agent_capabilities_emit(stopwatch->capabilities, "stopwatch", stopwatch->state.id,
                            "stopwatch.lap", value);
  } else if (strcmp(command->command, "show") == 0 && stopwatch->state.active) {
    prv_render(stopwatch);
    prv_schedule_tick(stopwatch);
  } else {
    return false;
  }
  return true;
}

static bool prv_event(AgentCapabilities *capabilities, const AgentUiEvent *event, void *module_context) {
  StopwatchModule *stopwatch = module_context;
  if (strcmp(event->action, "cap.stopwatch.toggle") == 0) {
    AgentCapabilityCommand command = {
      .type = "stopwatch",
      .command = stopwatch->state.running ? "pause" : "resume",
    };
    return prv_command(capabilities, &command, stopwatch);
  }
  if (strcmp(event->action, "cap.stopwatch.reset") == 0) {
    AgentCapabilityCommand command = { .type = "stopwatch", .command = "reset" };
    prv_command(capabilities, &command, stopwatch);
    agent_capabilities_emit(capabilities, "stopwatch", stopwatch->state.id, "stopwatch.reset", "0");
    return true;
  }
  return false;
}

static void prv_destroy(void *module_context) {
  StopwatchModule *stopwatch = module_context;
  if (stopwatch->tick_timer) { app_timer_cancel(stopwatch->tick_timer); }
  free(stopwatch);
}

bool agent_stopwatch_install(AgentCapabilities *capabilities) {
  StopwatchModule *stopwatch = calloc(1, sizeof(StopwatchModule));
  if (!stopwatch) { return false; }
  stopwatch->capabilities = capabilities;
  if (persist_read_data(STOPWATCH_PERSIST_KEY, &stopwatch->state, sizeof(stopwatch->state)) !=
        sizeof(stopwatch->state) || stopwatch->state.magic != STOPWATCH_MAGIC) {
    memset(&stopwatch->state, 0, sizeof(stopwatch->state));
    stopwatch->state.magic = STOPWATCH_MAGIC;
  }
  if (!agent_capabilities_register(capabilities, "stopwatch", (AgentCapabilityModule) {
        .command = prv_command,
        .event = prv_event,
        .destroy = prv_destroy,
      }, stopwatch)) {
    free(stopwatch);
    return false;
  }
  if (stopwatch->state.active) {
    prv_render(stopwatch);
    prv_schedule_tick(stopwatch);
  }
  return true;
}

