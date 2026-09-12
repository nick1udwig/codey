# Choices and time controls

## Concrete local choices

A local action is executed only when selected, without phone or model involvement:

```pam
pam version=1
screen id=when layout=choice title="When to remind?" status=true
  text id=question value="Send a birthday card"
  choice id=day title="In 1 day" action=local.run capability=reminder seconds=86400 task="Send a birthday card"
  choice id=week title="In 1 week" action=local.run capability=reminder seconds=604800 task="Send a birthday card"
  action id=custom title="Dictate answer" action=local.answer
done
```

`local.run` supports `capability=timer|reminder|alarm`, a `task` of at most 71
UTF-8 bytes, and integer `seconds=1..604800`. The delay starts when the user
confirms, not when the screen was generated. Native storage/capacity errors are
shown on the watch. This creates a new item; it never replaces an existing one.
The task is the created item's label, not the option's display title.

## Slider and winding dial

Use a slider for a bounded linear choice; use a dial for winding a duration up
and down. Both are fields, with integer `min`, `max`, `step`, `value`, and a short
`unit` label. Bounds: 0 <= min < max <= 604800, 1 <= step <= max-min. For local
creation use min >= 1. Values are seconds when passed to local actions.

```pam
pam version=1
screen id=duration layout=form title="Timer duration" status=true
  field id=delay title="Choose duration" type=slider min=60 max=3600 step=60 value=300 unit="seconds" action=local.run capability=timer seconds="$value" task="Pasta"
  action id=start title="Start timer" action=local.submit control=delay
  action id=custom title="Dictate answer" action=local.answer
done
```

Change `type=slider` to `type=dial` for a circular wind-up control. One revolution
covers the full range; crossing 12 o'clock changes smoothly, and stops at bounds.
Dragging adjusts the value but does not execute anything. Include a separate
`local.submit control=<field-id>` action to confirm. On button-only input, Select
on the field opens a number picker; Up/Down adjust and Select confirms the field's
action. Back cancels. Users can scroll by dragging outside the control's body.

A field with an ordinary action, such as `action=choose_delay`, sends its chosen
value to the agent on confirmation. Its `input.kind` is `field`. The dictated
alternative sends `input.kind=dictate-answer`, bypasses local speech regexes, and
keeps the thread and visible-screen context. Interpret it as an answer to your
question, including answers such as "after lunch" or a changed task.

## Limits

Each interactive element's metadata must fit 220 UTF-8 bytes, including attribute
names and quoting. Keep task names, IDs and unit labels short. Do not put a full
PAM document in an attribute. Slider/dial fields use 104/152 pixels vertically;
keep the screen focused on one question. Maximum 48 elements including dictation.
