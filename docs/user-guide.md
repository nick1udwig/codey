# Using codey

For installation and first setup, see the [README](../README.md).

## Controls and everyday use

Tap Talk to codey, then speak normally.
The phone first matches common commands locally.
Only unmatched dictation is sent to the configured Codex agent.
**Thinking** can appear briefly while the phone processes the transcription.

Local examples: “start a five-minute timer,” “set a timer for one hour and thirty minutes,” “set an alarm in ten minutes,” “set an alarm for 7:30 pm,” “wake me up tomorrow at seven am,” “remind me in an hour to check the oven,” “pause the stopwatch,” “show my timers,” “cancel all alarms,” and “what's the weather?”
These commands need no agent endpoint; weather still uses the phone's location and weather service.

Clock alarms use the phone's local timezone.
AM/PM, noon/midnight, or 24-hour HH:MM notation is required; without a date they mean the next occurrence.
Ambiguous times (“set an alarm for seven”), recurring alarms, commands targeting an individual timer, and requests with additional instructions fall back to Codex unchanged.
Matching is for complete phrases, never just a command buried inside a longer sentence.
Relative durations support 1 second through 7 days.

## Dashboard

On the dashboard, Up opens Notifications, Down opens the selected collection, and Select starts dictation.
Touch taps open each section:

- **Clock / Calendar:** opens your upcoming calendar agenda.
  The public SDK cannot directly open the system Timeline; it is accessible from the watchface.
- **Weather:** shows current temperature, daily low/high, and a condition icon (including sun/moon and cloudy day/night variants).
  It refreshes through the phone on startup and every 15 minutes; cached readings older than an hour are discarded on refresh.
  Tapping opens the full forecast without an agent request.
  Location permission and connectivity are required; missing readings show dashes.
- **Notifications:** initially includes a **Welcome to codey** tour, which stays until you select **Got it**.
  After dismissal it stays empty until items exist, then shows their labels.
  Timer rings fill clockwise from 12 o’clock as elapsed time increases, freezing when paused and filling completely at completion.
  Up to four entries fit; additional entries are indicated by a “MORE” count.
  Select opens the complete live list of timers, alarms, reminders, and stopwatch controls.
- **Talk to codey:** dictates into the current conversation.
- **Todos:** shows the undone count and opens the active task list.
  Tap a checkbox or press Select to archive an item; archived items can be restored.
  Swipe vertically or use Up/Down to navigate.
  Drag item text horizontally, or hold Up to pan the selected item. Hold Down opens the collection menu.
  Add items by talking to codey: “make a to-do to buy milk,” “set a task to call José,” or “create a todo to book tickets.”
  The bare prefix also works: “to-do send a birthday card to John.” Speech variants `2D`, `2 d`, `two`, `two two`, `two do`, `to`, and `to o` also create a to-do when followed by item text at the start of dictation. These short prefixes are ambiguous: “to note the address” creates a task called “note the address.” Use “note: …” or “make a note …” to save a note. Embedded phrases and negated commands do not trigger this shortcut; “set two timers …” is not a to-do.

## Gestures and new chats

Drag scrollable text or lists directly to scroll; no arming tap is needed.
Up/Down scroll when they have no assigned action or next control to select.
By default, other touchscreen controls require an arming tap: tap twice to activate a control, or tap then hold/drag/swipe on the same target.
The arming tap expires after 1.5 seconds and is consumed by one gesture.
An unarmed hold or control-adjusting drag does nothing.
Menus and screen changes clear the arm; physical buttons keep their existing behavior.

Tap then hold Talk to codey (or hold Select on the dashboard) to open an animated menu with **Talk to codey** and **New Chat**.
The dashboard stays visible behind it; tap twice outside or press Back to dismiss.
New Chat resets the conversation before starting dictation and reports an unavailable phone after eight seconds.
On other screens, hold Select to dictate into the current conversation.

## Requests and stored items

Notes and to-dos are saved on the server. The phone queues accepted changes during server outages; the watch needs its phone connection to save. Cached pages are marked stale when the server is unavailable. See [collection setup and recovery](collections.md).
Agent requests animate into **Notifications** when the phone submits them. Local
dictation shortcuts do not show this animation.
A completed response buzzes during the configured notification window (45 seconds by default), without replacing the current screen.
After that window there is no automatic polling.
Opening Notifications immediately marks ongoing requests as **Checking** and refreshes them once.
Tap a request to refresh its status; finished requests open their answer, and ongoing requests offer **Cancel request**.
Connection failures keep the job available for another check.
Canceling does not undo work already performed.

To Do, Notes, and Calendar share the collection tile. Tap, then hold it, or hold
Down, to choose **To Do**, **Notes**, or **Calendar**. Down opens your selected
collection; the date tile also opens Calendar.
The last collection opened stays on the dashboard.
Say “make a note Call Jane” or “note: Call Jane.”
Open a note and select **Append to note** or **Replace entire note**.
Notes live on the server; the phone loads bounded summaries and revision-pinned content pages.
The watch persists the first page of truncated titles and loads it immediately
while refreshing from the phone. Full content is fetched in pages.
See [collection setup and backend sync](collections.md).

The arming tap shows a brief expanding ripple with edge reflection.
The next touch stops it immediately.
Disable the effect with **First-tap ripple animation** in phone settings.
**Require double tap** is a separate setting: turn it off to activate controls
with a single tap or hold. Both settings default to enabled.

## Timers, alerts, and Quick Launch

Back returns to the dashboard without stopping anything; Back from the dashboard exits the app.
On a timer, the X (Down) cancels only that timer, Select pauses/resumes it, and the arrow (Up) returns home.

You can have four timers and four alarms/reminders at once.
Finished alerts return you to Notifications and buzz every three seconds until acknowledged or snoozed.
Open a finished entry and press Select to acknowledge, or Down to snooze ten minutes.
Acknowledging one leaves other notifications active.
If you close codey with an unacknowledged alert, it requests a wakeup to remind you again in a minute.
Pebble only lets the app vibrate while running; if the system refuses a wakeup, codey displays “keep codey open” instead of silently promising a background alert.

Assign codey to a button in the watch's Quick Launch settings.
Launching with that shortcut opens dictation automatically; opening codey from the app menu shows the dashboard, and a scheduled wakeup shows notifications.

## Phone settings and conversations

Settings default to GPT-5.6 Luna, extra-high reasoning effort, fast mode, and live web search.
The Fast mode toggle requests priority processing and can be turned off for standard speed.
Explicitly saved preferences are preserved.
Use **Load available models** to fetch the server's supported choices.
Permissions control web search, user-file access, command execution, command networking, and auto-review.
Filesystem, command, network, and auto-review permissions start off.
Auto-review can approve exceptions to the selected baseline; when off, additional-permission requests are denied.
Changing permissions uses a separate conversation.
See [backend settings](server.md#codex-configuration).

The gear icon is supplied by the Pebble mobile app.
The settings page requires internet access when it opens.

To start fresh, check **Start new conversation when I save** in phone settings and save.
The next query opens a new agent thread with no previous conversation context.
Existing conversations are retained.
This is a one-time action; ordinary settings saves continue the current conversation.

## Troubleshooting

**A request is still working.**
Open Notifications and tap it to fetch current status.
The 45-second completion notification window does not stop the agent.
Check the server log for job acceptance/completion and agent activity.
Unconfirmed delivery means the phone has not received an acknowledgement; checking can safely retry the same job ID.
Upgrade both the server and watch app for the job API.

**Where are the server logs?**
Start debugging with `~/.codey/server.log`.
The server also writes the same records to stderr.
It rotates the file at 10 MiB and retains five backups, from `server.log.1` (newest) through `server.log.5` (oldest).
Set `CODEY_LOG_FILE` or pass `--log-file /absolute/path` to move it; pass `--log-file -` for stderr only.

**The home screen says Configure endpoint.**
Open codey's gear icon in the paired phone app, save a valid endpoint, then reopen the watchapp if needed.

**Dictation reports Voice unavailable, Voice disabled, or Voice connection failed.**
Check microphone/voice permissions and the phone/watch connection, then retry.
Voice recognition depends on the system dictation service.

**Weather cannot get a location.**
Allow location access for the Pebble mobile app and make sure the phone has network access.

**The settings page will not open.**
Confirm the phone is online.
The hosted page is [nick1udwig.github.io/codey/config/](https://nick1udwig.github.io/codey/config/).


## Calendar

Choose Calendar from the collection menu to see events in time order. The watch
caches the first eight dated titles; opening the list refreshes them through the
phone. Open an event for its end time, location, and description. Date-only events
are all day; their end date is exclusive.

Say “Add a calendar event: lunch tomorrow from noon to one at Café Central.”
Codey asks for missing dates or times, then saves the event through the phone.
Calendar defaults to Server only. For syncing, choose CalDAV in phone settings,
follow the four steps, and use the same calendar account in your usual calendar
app. See [backend setup](../README.md#backend-sync-setup). The agenda imports the
next 90 days and recurring occurrences. Manage edits, invitations, and recurring
series in your calendar app. This agenda lives in codey, separate from OS Timeline.

The dashboard counts all active tasks, all notes, or upcoming events, including
items beyond the cached first page. Completing a task updates the list from the
phone cache immediately while delivery continues in the background.
