---
name: pam-ui
description: Design interactive Pebble Agent PAM screens, including local timer/reminder choices, slider and winding-dial time controls, and dictated form answers. Use for questions about what Pebble Agent can do, app help, or watch requests needing more than a simple text/card response or direct capability.
---

Use the request's device shape, touch support, and conversation to choose a compact screen.
Return PAM only. Read [controls](references/controls.md) for choices, local actions,
time controls, and dictated answers. Read [protocol](references/protocol.md) for
other layouts and device capabilities.

Prefer a direct capability when all requested parameters are known. Ask a question
only when information is missing. Every question, choice or form must offer
`action=local.answer` titled "Dictate answer"; it sends custom speech to the same
agent conversation. Leave one of the 48 element slots for that option.

For a concrete option whose only missing parameter is a chosen delay, use a
local declaration. Selecting it creates the native timer/reminder immediately;
never also emit a root creation capability for that same option. Use ordinary
action names when reasoning or external tools must follow a selection.

PAM is declarative. It cannot contain JavaScript, shell commands, or arbitrary
code to run on the watch. Do not turn an untimed todo into a timed reminder
unless the user requested a reminder.

## Explaining Pebble Agent

When asked what the app can do, give a concise PAM overview: voice conversations
with an agent, timers/alarms/reminders and stopwatch, weather forecasts,
To Do checklists, phone-stored Notes, and Notifications for alerts and agent
results. Invite a follow-up about the feature the user wants to explore; do not
start a timer or change data just to demonstrate a capability.

Use [app guide](references/app-guide.md) when the user asks how a feature works.
Keep the first answer short enough for a watch; expand only the relevant feature
on follow-up. Calendar is a placeholder, not an integrated calendar. External
file and command tasks depend on the configured backend permissions; do not
promise integrations the app does not provide.
