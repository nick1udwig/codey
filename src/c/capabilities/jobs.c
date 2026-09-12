#include "../agent_protocol.h"
#include "internal.h"
#include <stdlib.h>
#include <string.h>

#define MAX_JOBS 24
#define JOB_KEY 4600
typedef struct {
  char id[32], title[72], status[24], error[180];
} Job;
typedef struct {
  AgentCapabilities *host;
  Job jobs[MAX_JOBS];
  char selected[32];
  time_t checking;
  time_t refreshing[MAX_JOBS];
  AppTimer *timeout_timer;
} Jobs;
static void tick(void *context);
static void schedule_timeout(Jobs *s) {
  if (s->timeout_timer) {
    app_timer_cancel(s->timeout_timer);
    s->timeout_timer = NULL;
  }
  time_t next = s->checking;
  for (int i = 0; i < MAX_JOBS; ++i)
    if (s->refreshing[i] && (!next || s->refreshing[i] < next))
      next = s->refreshing[i];
  if (next)
    s->timeout_timer =
        app_timer_register((uint32_t)AGENT_CAP_MAX(1, next - time(NULL)) * 1000, tick, s);
}
static Job *find(Jobs *s, const char *id) {
  for (int i = 0; i < MAX_JOBS; i++) {
    if (strcmp(s->jobs[i].id, id) == 0)
      return &s->jobs[i];
  }
  return NULL;
}
static bool running(Job *j) {
  return strcmp(j->status, "done") && strcmp(j->status, "failed") && strcmp(j->status, "canceled");
}
static void show(Jobs *s, Job *j, bool checking) {
  AgentUi *ui = agent_capabilities_ui(s->host);
  agent_capabilities_set_active(s->host, "jobs", true);
  agent_protocol_copy(s->selected, sizeof(s->selected), j->id);
  s->checking = checking ? time(NULL) + 12 : 0;
  schedule_timeout(s);
  agent_ui_begin(ui, "job-status", "list", "Agent request", "", "", 16);
  agent_capability_add_element(ui, "text", "job-title", "", "", j->title, "", "", 0);
  agent_capability_add_element(ui, "text", "job-state", "", "", checking ? "Checking…" : j->status,
                               "", "", 0);
  if (j->error[0] && !checking)
    agent_capability_add_element(ui, "text", "job-error", "", "", j->error, "", "", 0);
  agent_capability_add_element(ui, "item", j->id, "Check status", "", "", "local.job.open", "", 0);
  if (!running(j))
    agent_capability_add_element(ui, "item", "dismiss-job", "Dismiss", "", "", "local.job.dismiss",
                                 "", 0);
  if (running(j))
    agent_capability_add_element(ui, "item", "cancel-job", "Cancel request",
                                 "Work already done is not undone", "", "local.job.cancel", "", 4);
  agent_ui_end(ui);
  agent_ui_set_status(ui, "", false, checking);
}
static void dashboard(AgentCapabilities *host, void *context, bool refresh) {
  Jobs *s = context;
  if (refresh)
    return;
  for (int i = 0; i < MAX_JOBS; i++) {
    Job *j = &s->jobs[i];
    if (!j->id[0])
      continue;
    const char *status = s->refreshing[i]            ? "Checking…"
                         : running(j) && j->error[0] ? "Check unavailable"
                                                     : j->status;
    agent_capability_add_element(agent_capabilities_ui(host), "item", j->id, j->title, status, "",
                                 "local.job.open", "dashboard_kind=job", 0);
  }
}
static bool command(AgentCapabilities *host, const AgentCapabilityCommand *c, void *context) {
  Jobs *s = context;
  if (!strcmp(c->command, "refresh")) {
    bool any = false;
    for (int i = 0; i < MAX_JOBS; ++i) {
      if (s->jobs[i].id[0] && strcmp(s->jobs[i].id, "pending") && running(&s->jobs[i])) {
        s->refreshing[i] = time(NULL) + 22;
        any = true;
      }
    }
    schedule_timeout(s);
    if (any) {
      agent_capabilities_rebuild_dashboard(host);
      agent_capabilities_emit(host, "job", "", "refresh", "");
    }
    return true;
  }
  if (!strcmp(c->command, "checking")) {
    Job *j = find(s, c->id);
    if (j && running(j)) {
      s->refreshing[j - s->jobs] = time(NULL) + 22;
      if (agent_capabilities_is_active(host, "notifications"))
        agent_capabilities_rebuild_dashboard(host);
    }
    schedule_timeout(s);
    return true;
  }
  if (!strcmp(c->command, "reset")) {
    s->checking = 0;
    memset(s->refreshing, 0, sizeof(s->refreshing));
    memset(s->jobs, 0, sizeof(s->jobs));
    for (int i = 0; i < MAX_JOBS; i++)
      persist_delete(JOB_KEY + i);
  } else {
    Job *j = find(s, c->id);
    if (j)
      s->refreshing[j - s->jobs] = 0;
    if (!strcmp(c->command, "remove")) {
      if (j) {
        int i = j - s->jobs;
        memset(j, 0, sizeof(*j));
        persist_delete(JOB_KEY + i);
      }
    } else {
      if (!j) {
        for (int i = 0; i < MAX_JOBS; i++) {
          if (!s->jobs[i].id[0]) {
            j = &s->jobs[i];
            break;
          }
        }
      }
      if (!j)
        return false;
      Job before = *j;
      bool changed = strcmp(j->status, c->subtitle) != 0;
      agent_protocol_copy(j->id, sizeof(j->id), c->id);
      agent_protocol_copy(j->title, sizeof(j->title), c->title);
      agent_protocol_copy(j->status, sizeof(j->status), c->subtitle);
      agent_protocol_copy(j->error, sizeof(j->error), c->value);
      // Split to keep every Pebble persistence record below 256 bytes.
      int i = j - s->jobs;
      if (memcmp(&before, j, sizeof(before)) != 0) {
        persist_write_data(JOB_KEY + i, j, 128);
        persist_write_data(JOB_KEY + MAX_JOBS + i, ((char *)j) + 128, sizeof(*j) - 128);
      }
      if (agent_capabilities_is_active(host, "jobs") && !strcmp(s->selected, j->id))
        show(s, j, false);
      if (changed && (c->flags & 1) && !quiet_time_is_active())
        vibes_short_pulse();
    }
  }
  schedule_timeout(s);
  if (agent_capabilities_is_active(host, "notifications") ||
      agent_capabilities_is_active(host, "dashboard"))
    agent_capabilities_rebuild_dashboard(host);
  return true;
}
static bool event(AgentCapabilities *host, const AgentUiEvent *e, void *context) {
  Jobs *s = context;
  if (!strcmp(e->action, "local.job.dismiss")) {
    agent_capabilities_emit(host, "job", s->selected, "dismiss", "");
    agent_capabilities_show_notifications(host);
    return true;
  }
  bool cancel = !strcmp(e->action, "local.job.cancel");
  if (strcmp(e->action, "local.job.open") && !cancel)
    return false;
  Job *j = find(s, cancel ? s->selected : e->element_id);
  if (!j)
    return true;
  show(s, j, true);
  agent_capabilities_emit(host, "job", j->id, cancel ? "cancel" : "check", "");
  return true;
}
static void tick(void *context) {
  Jobs *s = context;
  s->timeout_timer = NULL;
  bool expired = false;
  time_t now = time(NULL);
  for (int i = 0; i < MAX_JOBS; ++i)
    if (s->refreshing[i] && s->refreshing[i] <= now) {
      s->refreshing[i] = 0;
      expired = true;
      agent_protocol_copy(s->jobs[i].error, sizeof(s->jobs[i].error),
                          "Phone unavailable. Tap to check again.");
    }
  if (expired && agent_capabilities_is_active(s->host, "notifications")) {
    agent_capabilities_rebuild_dashboard(s->host);
  }
  if (s->checking && s->checking <= now) {
    s->checking = 0;
    if (agent_capabilities_is_active(s->host, "jobs")) {
      agent_ui_set_status(agent_capabilities_ui(s->host), "Phone unavailable. Check again.", false,
                          false);
    }
  }
  schedule_timeout(s);
}
static void destroy(void *context) {
  Jobs *s = context;
  if (s->timeout_timer)
    app_timer_cancel(s->timeout_timer);
  free(s);
}
bool agent_jobs_install(AgentCapabilities *host) {
  Jobs *s = calloc(1, sizeof(*s));
  if (!s)
    return false;
  s->host = host;
  for (int i = 0; i < MAX_JOBS; i++) {
    if (persist_read_data(JOB_KEY + i, &s->jobs[i], 128) == 128) {
      persist_read_data(JOB_KEY + MAX_JOBS + i, ((char *)&s->jobs[i]) + 128, sizeof(Job) - 128);
      s->jobs[i].id[31] = 0;
      s->jobs[i].title[71] = 0;
      s->jobs[i].status[23] = 0;
      s->jobs[i].error[179] = 0;
    }
  }
  AgentCapabilityModule m = {
      .command = command, .event = event, .dashboard = dashboard, .destroy = destroy};
  if (!agent_capabilities_register(host, "job", m, s)) {
    free(s);
    return false;
  }
  return true;
}
