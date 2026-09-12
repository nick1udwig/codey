#include <pebble.h>

#include "agent_capabilities.h"
#include "agent_protocol.h"
#include "agent_ui.h"
#include "answer_notification.h"
#include "local_action.h"
#include "watch_response.h"
#include "message_keys.auto.h"

#include <stdlib.h>
#include <string.h>

#define OUTBOX_QUEUE_SIZE 12
#define OUTBOX_RETRY_MS 100
#define OUTBOX_VALUE_LENGTH 220
#define DICTATION_LENGTH 220
#define NEW_CHAT_TIMEOUT_MS 8000
#define RESPONSE_TIMEOUT_MS 135000

typedef struct {
  char type[24];
  uint32_t request_id;
  char operation[24];
  char element_id[AGENT_UI_ID_LENGTH];
  char action[AGENT_UI_ACTION_LENGTH];
  char value[OUTBOX_VALUE_LENGTH];
  char meta[96];
  uint8_t retries;
} OutgoingMessage;

static AgentUi *s_ui;
static AgentCapabilities *s_capabilities;
static DictationSession *s_dictation;
static uint32_t s_request_id;
static OutgoingMessage s_outbox[OUTBOX_QUEUE_SIZE];
static uint8_t s_outbox_count;
static bool s_outbox_busy;
static AppTimer *s_outbox_retry_timer;
static AppTimer *s_ready_timer;
static AppTimer *s_quick_launch_timer;
static AppTimer *s_new_chat_timer;
static AppTimer *s_response_timer;
static bool s_accept_remote;
static AnswerNotification s_answer_notification;
static WatchResponse s_response;
static bool s_dictation_active;
static bool s_answer_dictation;
static char s_answer_element[AGENT_UI_ID_LENGTH];
static uint32_t s_navigation_revision;
static uint32_t s_notification_revision;
static uint32_t s_next_action_request_id;
static uint32_t s_new_chat_request_id;
static uint32_t s_new_chat_navigation_revision;
static uint32_t s_new_chat_notification_revision;
static bool s_new_chat_pending;
static void prv_start_dictation(void *context);

static void prv_cancel_new_chat(void) {
  if (s_new_chat_timer) {
    app_timer_cancel(s_new_chat_timer);
    s_new_chat_timer = NULL;
  }
  s_new_chat_pending = false;
}

static void prv_new_chat_timeout(void *context) {
  (void)context;
  s_new_chat_timer = NULL;
  if (!s_new_chat_pending) { return; }
  s_new_chat_pending = false;
  if (s_new_chat_navigation_revision != agent_capabilities_navigation_revision(s_capabilities) ||
      s_new_chat_notification_revision != agent_capabilities_notification_revision(s_capabilities)) {
    return;
  }
  agent_ui_set_status(s_ui, "Phone unavailable", true, false);
}

static void prv_stop_response_timer(void) {
  if (s_response_timer) { app_timer_cancel(s_response_timer); s_response_timer = NULL; }
}

static void prv_response_timeout(void *context) {
  (void)context;
  s_response_timer = NULL;
  if (!s_accept_remote || (!s_response.active && !s_response.awaiting_begin)) { return; }
  watch_response_fail(&s_response);
  s_answer_notification.pending = false;
  s_accept_remote = false;
  if (s_navigation_revision == agent_capabilities_navigation_revision(s_capabilities) &&
      s_notification_revision == agent_capabilities_notification_revision(s_capabilities)) {
    agent_ui_set_status(s_ui, "Request failed: phone timed out", true, false);
  }
}

static void prv_begin_request(void) {
  prv_stop_response_timer();
  s_response_timer = app_timer_register(RESPONSE_TIMEOUT_MS, prv_response_timeout, NULL);
  s_answer_notification.pending = false;
  watch_response_wait(&s_response);
  s_accept_remote = true;
  s_navigation_revision = agent_capabilities_navigation_revision(s_capabilities);
  s_notification_revision = agent_capabilities_notification_revision(s_capabilities);
}

static const char *prv_tuple_string(DictionaryIterator *iter, uint32_t key) {
  Tuple *tuple = dict_find(iter, key);
  return tuple && tuple->type == TUPLE_CSTRING && tuple->length &&
         memchr(tuple->value->cstring, 0, tuple->length) ? tuple->value->cstring : "";
}

static int32_t prv_tuple_int(DictionaryIterator *iter, uint32_t key, int32_t fallback) {
  Tuple *tuple = dict_find(iter, key);
  if (!tuple) { return fallback; }
  switch (tuple->type) {
    case TUPLE_INT:
      if (tuple->length == 1) { return tuple->value->int8; }
      if (tuple->length == 2) { return tuple->value->int16; }
      return tuple->length == 4 ? tuple->value->int32 : fallback;
    case TUPLE_UINT:
      if (tuple->length == 1) { return tuple->value->uint8; }
      if (tuple->length == 2) { return tuple->value->uint16; }
      return tuple->length == 4 && tuple->value->uint32 <= INT32_MAX ? (int32_t)tuple->value->uint32 : fallback;
    default:
      return fallback;
  }
}

static void prv_flush_outbox(void);

static void prv_remove_outbox_head(void) {
  if (!s_outbox_count) { return; }
  if (s_outbox_count > 1) {
    memmove(&s_outbox[0], &s_outbox[1], (s_outbox_count - 1) * sizeof(OutgoingMessage));
  }
  s_outbox_count -= 1;
}

static void prv_outbox_retry(void *context) {
  (void)context;
  s_outbox_retry_timer = NULL;
  prv_flush_outbox();
}

static void prv_schedule_retry(void) {
  if (!s_outbox_retry_timer) {
    s_outbox_retry_timer = app_timer_register(OUTBOX_RETRY_MS, prv_outbox_retry, NULL);
  }
}

static void prv_finish_outbox(bool sent) {
  OutgoingMessage *message;
  if (!s_outbox_count) {
    s_outbox_busy = false;
    return;
  }
  message = &s_outbox[0];
  s_outbox_busy = false;
  if (!sent && message->retries < 3) {
    message->retries += 1;
    prv_schedule_retry();
    return;
  }
  if (!sent) {
    agent_ui_set_status(s_ui, "Phone message failed", true, false);
  }
  prv_remove_outbox_head();
  prv_flush_outbox();
}

static void prv_flush_outbox(void) {
  DictionaryIterator *iter;
  AppMessageResult result;
  OutgoingMessage *message;
  if (s_outbox_busy || !s_outbox_count) { return; }
  message = &s_outbox[0];
  result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    prv_finish_outbox(false);
    return;
  }
  dict_write_cstring(iter, MESSAGE_KEY_MessageType, message->type);
  dict_write_int32(iter, MESSAGE_KEY_RequestId, (int32_t)message->request_id);
  if (message->operation[0]) { dict_write_cstring(iter, MESSAGE_KEY_Operation, message->operation); }
  if (message->element_id[0]) { dict_write_cstring(iter, MESSAGE_KEY_ElementId, message->element_id); }
  if (message->action[0]) { dict_write_cstring(iter, MESSAGE_KEY_Action, message->action); }
  if (message->value[0]) { dict_write_cstring(iter, MESSAGE_KEY_Value, message->value); }
  if (message->meta[0]) { dict_write_cstring(iter, MESSAGE_KEY_Meta, message->meta); }
  s_outbox_busy = true;
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    s_outbox_busy = false;
    if (result == APP_MSG_BUSY) { prv_schedule_retry(); }
    else { prv_finish_outbox(false); }
  }
}

static bool prv_queue_message(const char *type, uint32_t request_id, const char *operation,
                              const char *element_id, const char *action, const char *value,
                              const char *meta) {
  OutgoingMessage *message;
  if (s_outbox_count >= OUTBOX_QUEUE_SIZE) {
    agent_ui_set_status(s_ui, "Phone queue full", true, false);
    return false;
  }
  message = &s_outbox[s_outbox_count++];
  memset(message, 0, sizeof(*message));
  agent_protocol_copy(message->type, sizeof(message->type), type);
  message->request_id = request_id;
  agent_protocol_copy(message->operation, sizeof(message->operation), operation);
  agent_protocol_copy(message->element_id, sizeof(message->element_id), element_id);
  agent_protocol_copy(message->action, sizeof(message->action), action);
  agent_protocol_copy(message->value, sizeof(message->value), value);
  agent_protocol_copy(message->meta, sizeof(message->meta), meta);
  prv_flush_outbox();
  return true;
}

static void prv_background_request(const char *title) {
  agent_capabilities_show_dashboard(s_capabilities);
  AgentCapabilityCommand job = { .type="job", .command="upsert", .id="pending", .title=title,
    .subtitle="Sending to phone", .value="", .meta="" };
  agent_capabilities_handle_command(s_capabilities, &job);
  agent_ui_animate_request(s_ui);
  prv_begin_request();
}

static void prv_ui_event(const AgentUiEvent *event, void *context) {
  (void)context;
  // Any newer interaction supersedes an unacknowledged new-chat request. Its
  // delayed phone acknowledgment must never open dictation on another screen.
  prv_cancel_new_chat();
  if (strcmp(event->action, "local.dictate") == 0) { prv_start_dictation(NULL); return; }
  if (strcmp(event->action, "local.answer") == 0) {
    agent_protocol_copy(s_answer_element, sizeof(s_answer_element), event->element_id);
    prv_start_dictation((void *)1); return;
  }
  if (strcmp(event->action, "local.run") == 0) {
    AgentCapabilityCommand command; char type[20], task[72], args[48];
    if (!local_action_build(event, &command, type, task, args, sizeof(args))) {
      agent_ui_set_status(s_ui, "Invalid local action", true, false); return;
    }
    s_accept_remote = false; watch_response_fail(&s_response); prv_stop_response_timer();
    agent_capabilities_handle_command(s_capabilities, &command); return;
  }
  if (strcmp(event->action, "local.new-chat") == 0) {
    s_accept_remote = false;
    s_next_action_request_id = s_next_action_request_id == INT32_MAX ? 1 : s_next_action_request_id + 1;
    if (!s_next_action_request_id) { s_next_action_request_id = 1; }
    s_new_chat_request_id = s_next_action_request_id;
    s_new_chat_navigation_revision = agent_capabilities_navigation_revision(s_capabilities);
    s_new_chat_notification_revision = agent_capabilities_notification_revision(s_capabilities);
    s_new_chat_pending = true;
    s_new_chat_timer = app_timer_register(NEW_CHAT_TIMEOUT_MS, prv_new_chat_timeout, NULL);
    if (!s_new_chat_timer || !prv_queue_message("input", s_new_chat_request_id, "new-chat", "", "local.new-chat", "", "")) {
      prv_cancel_new_chat();
      agent_ui_set_status(s_ui, "Phone unavailable", true, false);
      return;
    }
    agent_ui_set_status(s_ui, "Starting new chat", false, true);
    return;
  }
  if (strcmp(event->action, "local.weather") == 0) {
    prv_begin_request();
    prv_queue_message("input", s_request_id, "dictation", "", "local.weather", "weather", "");
    agent_ui_set_status(s_ui, "Loading weather", false, true);
    return;
  }
  if (agent_capabilities_handle_ui_event(s_capabilities, event)) {
    return;
  }
  prv_background_request(event->value[0] ? event->value : "Agent request");
  prv_queue_message("input", s_request_id, event->input, event->element_id,
                    event->action, event->value, "");
}

static const char *prv_dictation_error(DictationSessionStatus status) {
  switch (status) {
    case DictationSessionStatusFailureTranscriptionRejected:
    case DictationSessionStatusFailureTranscriptionRejectedWithError:
      return "Dictation canceled";
    case DictationSessionStatusFailureNoSpeechDetected:
      return "No speech detected";
    case DictationSessionStatusFailureConnectivityError:
      return "Voice connection failed";
    case DictationSessionStatusFailureDisabled:
      return "Voice disabled";
    case DictationSessionStatusFailureRecognizerError:
      return "Voice recognition failed";
    default:
      return "Dictation failed";
  }
}

static void prv_dictation_callback(DictationSession *session, DictationSessionStatus status,
                                    char *transcription, void *context) {
  (void)session;
  (void)context;
  s_dictation_active = false;
  if (status != DictationSessionStatusSuccess || !transcription || !transcription[0]) {
    agent_ui_set_status(s_ui, prv_dictation_error(status), true, false);
    return;
  }
  prv_background_request(transcription);
  prv_queue_message("input", s_request_id, s_answer_dictation ? "dictate-answer" : "dictation",
                    s_answer_dictation ? s_answer_element : "", s_answer_dictation ? "local.answer" : "", transcription, "");
  s_answer_dictation = false;

}

static void prv_start_dictation(void *context) {
  (void)context;
  // The regular physical-select path can enter here without a UI action
  // callback. It still supersedes any delayed New Chat acknowledgment.
  prv_cancel_new_chat();
#if defined(PBL_MICROPHONE)
  if (s_dictation_active) { return; }
  s_answer_dictation = context != NULL;
  if (!s_dictation) {
    agent_ui_set_status(s_ui, "Voice unavailable", true, false);
    return;
  }
  agent_ui_set_status(s_ui, "Listening", false, true);
  s_dictation_active = true;
  if (dictation_session_start(s_dictation) != DictationSessionStatusSuccess) {
    s_dictation_active = false;
    agent_ui_set_status(s_ui, "Voice unavailable", true, false);
  }
#else
  agent_ui_set_status(s_ui, "No microphone", true, false);
#endif
}

static void prv_capability_event(const char *type, const char *id, const char *action,
                                 const char *value, void *context) {
  (void)context;
  if (strcmp(type, "job") == 0 && (!strcmp(action,"check") || !strcmp(action,"cancel"))) { prv_begin_request(); }
  prv_queue_message("capability_event", s_request_id, type, id, action, value, "");
}

static uint32_t prv_spec_presence(DictionaryIterator *iter) {
  uint32_t present = 0;
  if (dict_find(iter, MESSAGE_KEY_Kind)) { present |= AgentUiPresentKind; }
  if (dict_find(iter, MESSAGE_KEY_ElementId)) { present |= AgentUiPresentId; }
  if (dict_find(iter, MESSAGE_KEY_ParentId)) { present |= AgentUiPresentParentId; }
  if (dict_find(iter, MESSAGE_KEY_Title)) { present |= AgentUiPresentTitle; }
  if (dict_find(iter, MESSAGE_KEY_Subtitle)) { present |= AgentUiPresentSubtitle; }
  if (dict_find(iter, MESSAGE_KEY_Value)) { present |= AgentUiPresentValue; }
  if (dict_find(iter, MESSAGE_KEY_Action)) { present |= AgentUiPresentAction; }
  if (dict_find(iter, MESSAGE_KEY_Meta)) { present |= AgentUiPresentMeta; }
  if (dict_find(iter, MESSAGE_KEY_Flags)) { present |= AgentUiPresentFlags; }
  if (dict_find(iter, MESSAGE_KEY_Index)) { present |= AgentUiPresentIndex; }
  return present;
}

static AgentUiElementSpec prv_read_spec(DictionaryIterator *iter) {
  return (AgentUiElementSpec) {
    .kind = prv_tuple_string(iter, MESSAGE_KEY_Kind),
    .id = prv_tuple_string(iter, MESSAGE_KEY_ElementId),
    .parent_id = prv_tuple_string(iter, MESSAGE_KEY_ParentId),
    .title = prv_tuple_string(iter, MESSAGE_KEY_Title),
    .subtitle = prv_tuple_string(iter, MESSAGE_KEY_Subtitle),
    .value = prv_tuple_string(iter, MESSAGE_KEY_Value),
    .action = prv_tuple_string(iter, MESSAGE_KEY_Action),
    .meta = prv_tuple_string(iter, MESSAGE_KEY_Meta),
    .flags = prv_tuple_int(iter, MESSAGE_KEY_Flags, 0),
    .index = prv_tuple_int(iter, MESSAGE_KEY_Index, 0),
    .present = prv_spec_presence(iter),
  };
}

static bool prv_accept_request(uint32_t request_id, const char *operation) {
  if (strcmp(operation, "begin") == 0) {
    if (request_id == 0 && agent_capabilities_has_active(s_capabilities)) {
      return false;
    }
    s_request_id = request_id;
    return true;
  }
  return request_id == s_request_id;
}

static void prv_handle_render(DictionaryIterator *iter, uint32_t request_id, const char *operation) {
  AgentUiElementSpec spec;
  if (!prv_accept_request(request_id, operation)) { return; }
  if (strcmp(operation, "begin") == 0) {
    agent_capabilities_set_active(s_capabilities, "remote", true);
    agent_ui_begin(s_ui,
                   prv_tuple_string(iter, MESSAGE_KEY_ElementId),
                   prv_tuple_string(iter, MESSAGE_KEY_Kind),
                   prv_tuple_string(iter, MESSAGE_KEY_Title),
                   prv_tuple_string(iter, MESSAGE_KEY_Subtitle),
                   prv_tuple_string(iter, MESSAGE_KEY_Meta),
                   prv_tuple_int(iter, MESSAGE_KEY_Flags, 0));
  } else if (strcmp(operation, "add") == 0) {
    spec = prv_read_spec(iter);
    if (!agent_ui_add(s_ui, &spec)) {
      agent_ui_set_status(s_ui, "Screen is too large", true, false);
    }
  } else if (strcmp(operation, "patch") == 0) {
    spec = prv_read_spec(iter);
    agent_ui_patch(s_ui, &spec);
  } else if (strcmp(operation, "append") == 0) {
    agent_ui_append(s_ui, prv_tuple_string(iter, MESSAGE_KEY_ElementId),
                    prv_tuple_string(iter, MESSAGE_KEY_Value));
  } else if (strcmp(operation, "remove") == 0) {
    agent_ui_remove(s_ui, prv_tuple_string(iter, MESSAGE_KEY_ElementId));
  } else if (strcmp(operation, "end") == 0) {
    agent_ui_end(s_ui);
  }
}

static void prv_handle_capability(DictionaryIterator *iter, uint32_t request_id,
                                  const char *operation) {
  AgentCapabilityCommand command = {
    .type = prv_tuple_string(iter, MESSAGE_KEY_Kind),
    .command = operation,
    .id = prv_tuple_string(iter, MESSAGE_KEY_ElementId),
    .title = prv_tuple_string(iter, MESSAGE_KEY_Title),
    .subtitle = prv_tuple_string(iter, MESSAGE_KEY_Subtitle),
    .value = prv_tuple_string(iter, MESSAGE_KEY_Value),
    .meta = prv_tuple_string(iter, MESSAGE_KEY_Meta),
    .flags = prv_tuple_int(iter, MESSAGE_KEY_Flags, 0),
    .invocation_id = (uint32_t)prv_tuple_int(iter, MESSAGE_KEY_Index, 0),
  };
  s_request_id = request_id;
  if (!agent_capabilities_handle_command(s_capabilities, &command)) {
    agent_ui_set_status(s_ui, "Unsupported capability command", true, false);
  }
  if (s_notification_revision != agent_capabilities_notification_revision(s_capabilities)) {
    agent_capabilities_show_notifications(s_capabilities);
  }
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  const char *type = prv_tuple_string(iter, MESSAGE_KEY_MessageType);
  const char *operation = prv_tuple_string(iter, MESSAGE_KEY_Operation);
  uint32_t request_id = (uint32_t)prv_tuple_int(iter, MESSAGE_KEY_RequestId, 0);
  (void)context;
  if (strcmp(type, "job") == 0) {
    const char *id = prv_tuple_string(iter, MESSAGE_KEY_ElementId);
    if (strcmp(operation, "upsert") == 0 && strcmp(id, "pending") != 0) {
      AgentCapabilityCommand remove = { .type="job", .command="remove", .id="pending" };
      agent_capabilities_handle_command(s_capabilities, &remove);
    }
    AgentCapabilityCommand command = { .type="job", .command=operation, .id=id,
      .title=prv_tuple_string(iter, MESSAGE_KEY_Title), .subtitle=prv_tuple_string(iter, MESSAGE_KEY_Subtitle),
      .value=prv_tuple_string(iter, MESSAGE_KEY_Value), .meta="", .flags=prv_tuple_int(iter, MESSAGE_KEY_Flags, 0) };
    agent_capabilities_handle_command(s_capabilities, &command);
    if (strcmp(command.subtitle, "sending") == 0) { prv_stop_response_timer(); }
    return;
  }
  if (strcmp(type, "bridge") == 0 && strcmp(operation, "weather") == 0) {
    agent_capabilities_set_weather(s_capabilities, prv_tuple_string(iter, MESSAGE_KEY_Value),
      prv_tuple_string(iter, MESSAGE_KEY_Subtitle), prv_tuple_string(iter, MESSAGE_KEY_Meta));
    return;
  }
  if (strcmp(type, "bridge") == 0) {
    agent_capabilities_set_connection(s_capabilities, prv_tuple_string(iter, MESSAGE_KEY_Value));
    return;
  }
  if (strcmp(type, "answer") == 0) {
    if (strcmp(operation, "begin") == 0 && s_accept_remote &&
        s_navigation_revision == agent_capabilities_navigation_revision(s_capabilities) &&
        watch_response_begin(&s_response, request_id)) {
      s_request_id = request_id;
      s_answer_notification = (AnswerNotification) { .request_id = request_id, .pending = true };
    } else if (strcmp(operation, "complete") == 0) {
      if (watch_response_accepts(&s_response, request_id)) { prv_stop_response_timer(); }
      answer_notification_complete(&s_answer_notification, request_id,
                                   prv_tuple_int(iter, MESSAGE_KEY_Flags, 0) == 1);
    }
    return;
  }
  if (strcmp(type, "control") == 0 && strcmp(operation, "dictate") == 0) {
    if (!s_new_chat_pending || request_id != s_new_chat_request_id) { return; }
    prv_cancel_new_chat();
    if (s_new_chat_navigation_revision != agent_capabilities_navigation_revision(s_capabilities) ||
        s_new_chat_notification_revision != agent_capabilities_notification_revision(s_capabilities)) {
      return;
    }
    prv_start_dictation(NULL);
    return;
  }
  if (!s_accept_remote || s_navigation_revision != agent_capabilities_navigation_revision(s_capabilities)) { return; }
  // A timer may expire while a new request is Thinking. Execute its capability
  // commands, but keep late screen/status traffic from hiding the notification.
  if (strcmp(type, "capability") != 0 &&
      s_notification_revision != agent_capabilities_notification_revision(s_capabilities)) { return; }
  if (!watch_response_accepts(&s_response, request_id)) { return; }
  if (strcmp(type, "job-result") == 0) {
    prv_stop_response_timer();
    prv_queue_message("capability_event", request_id, "job", prv_tuple_string(iter, MESSAGE_KEY_ElementId), "retrieved", "", "");
  } else if (strcmp(type, "render") == 0) {
    prv_handle_render(iter, request_id, operation);
  } else if (strcmp(type, "capability") == 0) {
    prv_handle_capability(iter, request_id, operation);
  } else if (strcmp(type, "status") == 0 && (request_id == s_request_id || !request_id)) {
    if (strcmp(operation, "error") == 0) {
      prv_stop_response_timer();
      watch_response_fail(&s_response);
      s_answer_notification.pending = false;
    }
    agent_ui_set_status(s_ui, prv_tuple_string(iter, MESSAGE_KEY_Value),
                        strcmp(operation, "error") == 0,
                        strcmp(operation, "loading") == 0);
  }
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  (void)reason;
  (void)context;
  agent_ui_set_status(s_ui, "Phone message dropped", true, false);
}

static void prv_outbox_sent(DictionaryIterator *iter, void *context) {
  (void)iter;
  (void)context;
  prv_finish_outbox(true);
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  (void)iter;
  (void)reason;
  (void)context;
  prv_finish_outbox(false);
}

static void prv_send_ready(void *context) {
  (void)context;
  s_ready_timer = NULL;
  prv_queue_message("ready", 0, "ready", "", "",
                    "local-active", "");
}

static void prv_quick_launch(void *context) {
  s_quick_launch_timer = NULL;
  prv_start_dictation(context);
}

static void prv_show_boot(void) {
  agent_ui_begin(s_ui, "boot", "text", "Pebble Agent", "", "", 16);
  agent_ui_add(s_ui, &(AgentUiElementSpec) {
    .kind = "text",
    .id = "boot-text",
    .parent_id = "boot",
    .title = "",
    .subtitle = "",
    .value = "Connecting to phone…\n\nHold Select to dictate.",
    .action = "",
    .meta = "",
    .flags = 0,
    .index = 0,
    .present = AgentUiPresentAll,
  });
  agent_ui_set_status(s_ui, "Connecting", false, true);
}

static void prv_init(void) {
  s_ui = agent_ui_create(prv_ui_event, prv_start_dictation, NULL);
  if (!s_ui) { return; }
  s_capabilities = agent_capabilities_create(s_ui, prv_capability_event, NULL);
  if (!s_capabilities) { return; }
  if (!agent_capabilities_has_active(s_capabilities)) {
    prv_show_boot();
  }

  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_sent(prv_outbox_sent);
  app_message_register_outbox_failed(prv_outbox_failed);
  if (app_message_open(2048, 768) != APP_MSG_OK) {
    agent_capabilities_set_connection(s_capabilities, "Phone messaging unavailable");
  }

#if defined(PBL_MICROPHONE)
  s_dictation = dictation_session_create(DICTATION_LENGTH, prv_dictation_callback, NULL);
  if (s_dictation) {
    dictation_session_enable_confirmation(s_dictation, false);
    dictation_session_enable_error_dialogs(s_dictation, false);
  }
#endif
  agent_ui_show(s_ui, true);
  s_ready_timer = app_timer_register(250, prv_send_ready, NULL);
  if (launch_reason() == APP_LAUNCH_QUICK_LAUNCH) {
    s_quick_launch_timer = app_timer_register(400, prv_quick_launch, NULL);
  }
}

static void prv_deinit(void) {
  prv_stop_response_timer();
  if (s_ready_timer) { app_timer_cancel(s_ready_timer); }
  if (s_quick_launch_timer) { app_timer_cancel(s_quick_launch_timer); }
  if (s_new_chat_timer) { app_timer_cancel(s_new_chat_timer); }
  if (s_outbox_retry_timer) { app_timer_cancel(s_outbox_retry_timer); }
#if defined(PBL_MICROPHONE)
  if (s_dictation) { dictation_session_destroy(s_dictation); }
#endif
  agent_capabilities_destroy(s_capabilities);
  agent_ui_destroy(s_ui);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
