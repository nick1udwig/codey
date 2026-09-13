# codey feature guide

- **Talk to codey:** Select on the dashboard starts voice dictation. Short local
  commands such as “start a five-minute timer” are handled by the phone; other
  requests go to the self-hosted Codex service. Answers can be lists, cards,
  grids, forms and other watch-sized interactive screens. Hold Select on home
  for the Talk / New Chat menu; elsewhere hold Select to continue talking.
- **Notifications:** Up on home opens timers, alarms, reminders, stopwatch and
  agent requests. Opening the list checks ongoing requests once; open a request
  to check again, view its answer or cancel it. Work can continue after the phone
  stops waiting. Cancellation does not undo completed actions.
- **Time tools:** Four timers and four alarms/reminders can coexist. Timer Select
  pauses/resumes; Down cancels; Up returns home. Finished alerts buzz until
  acknowledged (Select) or snoozed ten minutes (Down). Background wakeups depend
  on the watch granting them. Stopwatch supports local controls. Clock alarms
  use the phone timezone; specify AM/PM or 24-hour time.
- **To Do:** Down on home opens a persistent watch checklist. Say “make a to-do
  to buy milk.” Select or double-tap the checkbox archives it; archived items
  can be restored. Up/Down scroll; hold Up/Down to pan long text.
- **Notes:** Tap then hold the To Do/Notes tile to choose the collection. Say
  “make a note Call Jane.” Open a note and choose Edit note to dictate its
  replacement. Notes are stored on the phone and fetched in pages.
- **Weather:** Open the Weather tile for a forecast without an agent request.
  Requires phone location permission and connectivity; refreshes every 15 minutes.
- **Controls:** Drag scrollable text and lists directly. Up/Down scroll when
  there is no assigned action or next control to select. Other touch interactions
  need an arming tap: tap twice to activate, or tap then hold/drag/swipe on the
  control. The arm expires after 1.5 seconds. Back goes home, then exits.
  A watch Quick Launch shortcut starts dictation on launch.
- **Setup:** In the Pebble phone app, open codey's gear/settings and enter the
  reachable service /v1/agent URL and matching bearer token. Model, reasoning,
  fast mode, search and backend permissions are configurable there. Voice needs
  the paired phone; local timers and To Do lists work offline. The server uses
  the operator's authenticated Codex CLI. Calendar currently only shows a
  placeholder; it cannot directly open the system Timeline.
- **Welcome tour:** A first-start notification stays available until Got it is
  selected. Users can ask the agent for help afterward.
