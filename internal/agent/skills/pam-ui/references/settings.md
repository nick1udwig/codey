# App settings

Read the request's `settings` child for the phone's saved preferences at request
time. Omitted settings are unknown; do not assume defaults. These are requested
preferences, not proof of the backend's effective model or permissions.

Change a preference with a root `capability type=settings command=set key=... value=...`.
Use one capability per setting and explicit values, never toggle commands.

| Key | Allowed values | Meaning |
| --- | --- | --- |
| `double_tap` | `true`, `false` | Require double tap to activate |
| `tap_animation` | `true`, `false` | First-tap ripple animation |
| `answer_vibrate` | `true`, `false` | Vibrate when an answer arrives |
| `fast_mode` | `true`, `false` | Backend fast mode |
| `units` | `auto`, `metric`, `imperial` | Weather units |
| `model` | Model ID or `default` | Requested backend model |
| `effort` | `default`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Requested reasoning effort |
| `web_search` | `disabled`, `cached`, `live` | Backend web search mode |

Model IDs are 1–128 ASCII characters: begin with a letter or digit, followed by
letters, digits, `.`, `_`, `:`, `/`, or `-`. `default` clears the model or effort
override so the server chooses. Use the user's requested model ID; saving it
does not establish that the backend supports it. Backend preferences take effect
on subsequent requests and remain subject to server restrictions.

For “disable double tap and use high reasoning effort”:

```pam
pam version=1
capability type=settings command=set key=double_tap value=false
capability type=settings command=set key=effort value=high
done
```

For “use the server's default model”:

```pam
pam version=1
capability type=settings command=set key=model value=default
done
```

The phone validates and saves each setting when the result arrives, updates
watch preferences, and refreshes weather when units change. Opening the result
shows the saved value without reapplying completed changes. Each line is a
separate update, not an atomic batch. Let the phone show success or failure;
do not emit a simulated success screen after the capability.

Credentials, endpoint, sync setup, file/network/shell permissions, and automatic
approval review are not writable through this capability; direct the user to
phone settings for those. Only `type`, `command`, `key`, `value`, and optional
`id` attributes are accepted. Ordinary `action=settings.save` or form fields do
not save preferences: handle the user's selection in the next turn by emitting
the root capability. Include `action=local.answer` on any question or form.
