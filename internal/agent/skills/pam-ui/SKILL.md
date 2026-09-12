---
name: pam-ui
description: Design interactive Pebble Agent PAM screens, including local timer/reminder choices, slider and winding-dial time controls, and dictated form answers. Use when a watch request needs more than a simple text/card response or a direct capability.
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
