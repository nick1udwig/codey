#include "internal.h"

#include "../agent_protocol.h"

#include <stdlib.h>
#include <string.h>

#define REMINDER_SLOT_COUNT 4
#define REMINDER_PERSIST_BASE 4120
#define REMINDER_MAGIC 0x524d4452
#define REMINDER_COOKIE_BASE 0x524d1000

typedef struct {
  uint32_t magic;
  bool active;
  time_t at;
  WakeupId wakeup_id;
  char id[AGENT_UI_ID_LENGTH];
  char title[AGENT_UI_TITLE_LENGTH];
  char body[84];
} ReminderRecord;

typedef struct {
  ReminderRecord reminders[REMINDER_SLOT_COUNT];
  int8_t visible_slot;
  AgentCapabilities *capabilities;
} ReminderModule;

static void prv_save(ReminderModule *reminders, uint8_t slot) {
  persist_write_data(REMINDER_PERSIST_BASE + slot, &reminders->reminders[slot],
                     sizeof(ReminderRecord));
}

static void prv_cancel(ReminderRecord *record) {
  if (record->wakeup_id >= 0) {
    wakeup_cancel(record->wakeup_id);
  }
  record->active = false;
  record->wakeup_id = -1;
}

static int prv_find_slot(ReminderModule *reminders, const char *id) {
  int index;
  int free_slot = -1;
  for (index = 0; index < REMINDER_SLOT_COUNT; index += 1) {
    if (reminders->reminders[index].active && id && id[0] &&
        strcmp(reminders->reminders[index].id, id) == 0) {
      return index;
    }
    if (!reminders->reminders[index].active && free_slot < 0) {
      free_slot = index;
    }
  }
  return free_slot;
}

static void prv_format_time(time_t timestamp, char *dest, size_t dest_size) {
  struct tm *local = localtime(&timestamp);
  if (!local) {
    agent_protocol_copy(dest, dest_size, "Scheduled");
    return;
  }
  if (clock_is_24h_style()) {
    strftime(dest, dest_size, "%a %H:%M", local);
  } else {
    strftime(dest, dest_size, "%a %l:%M %p", local);
  }
}

static void prv_show_confirmation(ReminderModule *reminders, int slot) {
  ReminderRecord *record = &reminders->reminders[slot];
  AgentUi *ui = agent_capabilities_ui(reminders->capabilities);
  char when[40];
  prv_format_time(record->at, when, sizeof(when));
  agent_ui_begin(ui, record->id, "modal", "Reminder set", "", "", 16);
  agent_capability_add_element(ui, "text", "reminder-title", "", "", record->title, "", "", 0);
  if (record->body[0]) {
    agent_capability_add_element(ui, "text", "reminder-body", "", "", record->body, "", "", 0);
  }
  agent_capability_add_element(ui, "metric", "reminder-time", "When", "", when, "", "", 0);
  agent_ui_end(ui);
  agent_capabilities_set_active(reminders->capabilities, "reminder", true);
}

static void prv_show_due(ReminderModule *reminders, int slot) {
  ReminderRecord *record = &reminders->reminders[slot];
  AgentUi *ui = agent_capabilities_ui(reminders->capabilities);
  reminders->visible_slot = slot;
  agent_ui_begin(ui, record->id, "modal", record->title[0] ? record->title : "Reminder",
                 "", "actionbar=true", 16);
  agent_capability_add_element(ui, "image", "reminder-icon", "Reminder", "", "warning", "",
                               "icon=warning", 0);
  agent_capability_add_element(ui, "text", "reminder-body", "", "",
                               record->body[0] ? record->body : "It's time.", "", "", 0);
  agent_capability_add_element(ui, "bind", "reminder-ack", "Done", "", "",
                               "cap.reminder.ack", "input=select icon=check", 0);
  agent_capability_add_element(ui, "bind", "reminder-snooze", "Snooze", "", "",
                               "cap.reminder.snooze", "input=down icon=timer", 0);
  agent_ui_end(ui);
  agent_capabilities_set_active(reminders->capabilities, "reminder", true);
  vibes_long_pulse();
}

static void prv_show_list(ReminderModule *reminders) {
  AgentUi *ui = agent_capabilities_ui(reminders->capabilities);
  int index;
  int count = 0;
  char when[40];
  char action[AGENT_UI_ACTION_LENGTH];
  agent_ui_begin(ui, "reminders", "list", "Reminders", "", "", 16);
  for (index = 0; index < REMINDER_SLOT_COUNT; index += 1) {
    ReminderRecord *record = &reminders->reminders[index];
    if (!record->active) { continue; }
    prv_format_time(record->at, when, sizeof(when));
    snprintf(action, sizeof(action), "cap.reminder.open.%d", index);
    agent_capability_add_element(ui, "item", record->id, record->title, when, "", action, "", 0);
    count += 1;
  }
  if (!count) {
    agent_capability_add_element(ui, "text", "empty", "", "", "No reminders", "", "", 0);
  }
  agent_ui_end(ui);
  agent_capabilities_set_active(reminders->capabilities, "reminder", true);
}

static bool prv_schedule(ReminderModule *reminders, const AgentCapabilityCommand *command) {
  char value[40];
  time_t at = 0;
  int slot;
  ReminderRecord *record;
  bool show;
  if (agent_protocol_meta_get(command->meta, "at", value, sizeof(value))) {
    at = (time_t)strtol(value, NULL, 10);
  } else if (agent_protocol_meta_get(command->meta, "in", value, sizeof(value))) {
    at = time(NULL) + agent_capability_parse_duration(value, 0);
  } else {
    at = time(NULL) + agent_capability_parse_duration(command->value, 0);
  }
  if (at <= time(NULL)) {
    agent_ui_set_status(agent_capabilities_ui(reminders->capabilities), "Reminder time must be future",
                        true, false);
    return false;
  }
  slot = prv_find_slot(reminders, command->id);
  if (slot < 0) {
    agent_ui_set_status(agent_capabilities_ui(reminders->capabilities), "Four reminders already set",
                        true, false);
    return false;
  }
  record = &reminders->reminders[slot];
  if (record->active) { prv_cancel(record); }
  memset(record, 0, sizeof(*record));
  record->magic = REMINDER_MAGIC;
  record->active = true;
  record->at = at;
  record->wakeup_id = wakeup_schedule(at, REMINDER_COOKIE_BASE + slot, true);
  agent_protocol_copy(record->id, sizeof(record->id), command->id && command->id[0] ? command->id : "reminder");
  agent_protocol_copy(record->title, sizeof(record->title),
                      command->title && command->title[0] ? command->title : "Reminder");
  agent_protocol_copy(record->body, sizeof(record->body),
                      command->subtitle && command->subtitle[0] ? command->subtitle : command->value);
  if (record->wakeup_id < 0) {
    record->active = false;
    agent_ui_set_status(agent_capabilities_ui(reminders->capabilities), "Could not schedule reminder",
                        true, false);
    return false;
  }
  prv_save(reminders, slot);
  show = agent_protocol_meta_get_bool(command->meta, "show", true);
  if (show) { prv_show_confirmation(reminders, slot); }
  agent_capabilities_emit(reminders->capabilities, "reminder", record->id, "reminder.scheduled", "");
  return true;
}

static bool prv_command(AgentCapabilities *capabilities, const AgentCapabilityCommand *command,
                        void *module_context) {
  ReminderModule *reminders = module_context;
  int slot;
  int index;
  (void)capabilities;
  if (strcmp(command->command, "schedule") == 0 || strcmp(command->command, "create") == 0 ||
      strcmp(command->command, "set") == 0) {
    return prv_schedule(reminders, command);
  }
  if (strcmp(command->command, "list") == 0) {
    prv_show_list(reminders);
    return true;
  }
  if (strcmp(command->command, "cancel") == 0) {
    slot = prv_find_slot(reminders, command->id);
    if (slot >= 0 && reminders->reminders[slot].active) {
      prv_cancel(&reminders->reminders[slot]);
      prv_save(reminders, slot);
      agent_capabilities_emit(reminders->capabilities, "reminder", command->id,
                              "reminder.canceled", "");
      return true;
    }
    return false;
  }
  if (strcmp(command->command, "cancel_all") == 0) {
    for (index = 0; index < REMINDER_SLOT_COUNT; index += 1) {
      prv_cancel(&reminders->reminders[index]);
      prv_save(reminders, index);
    }
    return true;
  }
  if (strcmp(command->command, "show") == 0) {
    slot = prv_find_slot(reminders, command->id);
    if (slot >= 0 && reminders->reminders[slot].active) {
      prv_show_confirmation(reminders, slot);
      return true;
    }
  }
  return false;
}

static bool prv_event(AgentCapabilities *capabilities, const AgentUiEvent *event, void *module_context) {
  ReminderModule *reminders = module_context;
  ReminderRecord *record;
  int slot;
  if (strncmp(event->action, "cap.reminder.open.", 18) == 0) {
    slot = atoi(event->action + 18);
    if (slot >= 0 && slot < REMINDER_SLOT_COUNT && reminders->reminders[slot].active) {
      prv_show_confirmation(reminders, slot);
    }
    return true;
  }
  if (strcmp(event->action, "cap.reminder.ack") != 0 &&
      strcmp(event->action, "cap.reminder.snooze") != 0) {
    return false;
  }
  slot = reminders->visible_slot;
  if (slot < 0 || slot >= REMINDER_SLOT_COUNT) { return true; }
  record = &reminders->reminders[slot];
  if (strcmp(event->action, "cap.reminder.snooze") == 0) {
    record->at = time(NULL) + 600;
    record->wakeup_id = wakeup_schedule(record->at, REMINDER_COOKIE_BASE + slot, true);
    record->active = record->wakeup_id >= 0;
    prv_save(reminders, slot);
    agent_ui_set_status(agent_capabilities_ui(capabilities), "Snoozed 10 minutes", false, false);
    agent_capabilities_emit(capabilities, "reminder", record->id, "reminder.snoozed", "600");
  } else {
    prv_cancel(record);
    prv_save(reminders, slot);
    agent_ui_set_status(agent_capabilities_ui(capabilities), "Reminder complete", false, false);
    agent_capabilities_emit(capabilities, "reminder", record->id, "reminder.acknowledged", "");
  }
  reminders->visible_slot = -1;
  agent_capabilities_set_active(capabilities, "reminder", false);
  return true;
}

static bool prv_wakeup(AgentCapabilities *capabilities, WakeupId wakeup_id, int32_t cookie,
                       void *module_context) {
  ReminderModule *reminders = module_context;
  int slot = cookie - REMINDER_COOKIE_BASE;
  (void)capabilities;
  if (slot < 0 || slot >= REMINDER_SLOT_COUNT || !reminders->reminders[slot].active) {
    return false;
  }
  reminders->reminders[slot].wakeup_id = wakeup_id;
  prv_show_due(reminders, slot);
  return true;
}

static void prv_destroy(void *module_context) {
  free(module_context);
}

bool agent_reminder_install(AgentCapabilities *capabilities) {
  ReminderModule *reminders = calloc(1, sizeof(ReminderModule));
  WakeupId launch_id;
  int32_t launch_cookie;
  int launch_slot = -1;
  int index;
  if (!reminders) { return false; }
  reminders->capabilities = capabilities;
  reminders->visible_slot = -1;
  for (index = 0; index < REMINDER_SLOT_COUNT; index += 1) {
    ReminderRecord *record = &reminders->reminders[index];
    if (persist_read_data(REMINDER_PERSIST_BASE + index, record, sizeof(*record)) != sizeof(*record) ||
        record->magic != REMINDER_MAGIC) {
      memset(record, 0, sizeof(*record));
      record->magic = REMINDER_MAGIC;
      record->wakeup_id = -1;
    }
  }
  if (!agent_capabilities_register(capabilities, "reminder", (AgentCapabilityModule) {
        .command = prv_command,
        .event = prv_event,
        .wakeup = prv_wakeup,
        .destroy = prv_destroy,
      }, reminders)) {
    free(reminders);
    return false;
  }
  if (wakeup_get_launch_event(&launch_id, &launch_cookie) &&
      launch_cookie >= REMINDER_COOKIE_BASE && launch_cookie < REMINDER_COOKIE_BASE + REMINDER_SLOT_COUNT) {
    launch_slot = launch_cookie - REMINDER_COOKIE_BASE;
    prv_wakeup(capabilities, launch_id, launch_cookie, reminders);
  }
  for (index = 0; index < REMINDER_SLOT_COUNT; index += 1) {
    ReminderRecord *record = &reminders->reminders[index];
    if (!record->active || index == launch_slot) { continue; }
    if (record->at <= time(NULL)) {
      prv_show_due(reminders, index);
      continue;
    }
    if (record->wakeup_id >= 0) { wakeup_cancel(record->wakeup_id); }
    record->wakeup_id = wakeup_schedule(record->at, REMINDER_COOKIE_BASE + index, true);
    if (record->wakeup_id < 0) {
      record->active = false;
    }
    prv_save(reminders, index);
  }
  return true;
}
