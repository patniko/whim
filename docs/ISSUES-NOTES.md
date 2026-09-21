# Issues Notes (Scratchpad)

Running log of issues encountered while using whim, captured for later triage/processing.
Not a substitute for GitHub Issues — items here should be promoted (filed as real issues) once processed.

## Format

Each entry:

```
## [YYYY-MM-DD] Short title
- Area: (cli/agent/runtime/canvas/etc.)
- Description:
- Expected:
- Actual:
- Repro steps (if known):
- Notes:
- Status: unprocessed | filed as #<n> | fixed | wontfix
```

---

## [2026-09-13] Agent chat pane: scroll jitters/sticks near bottom while agent is working
- Area: agent chat window (main side pane)
- Description: While the agent is actively working, scrolling up/down in the chat window doesn't work smoothly. It jitters and gets stuck near the bottom, as if auto-scroll-to-bottom is fighting the user's manual scroll on every content update.
- Expected: User should be able to freely scroll up to read earlier messages while the agent streams new content; auto-scroll should only apply when the user is already at/near the bottom (or pause auto-scroll once user scrolls up).
- Actual: Scroll position keeps getting pulled back down during streaming, making it hard to read.
- Repro steps: Open agent chat side pane, send a message that takes a while to process, try scrolling up while it's streaming.
- Notes:
- Status: unprocessed

## [2026-09-13] Remove "earlier" / "later" / "latest" message navigation buttons
- Area: agent chat window (main side pane)
- Description: The "earlier", "later", and "latest" message buttons in the chat UI are visually unappealing and not needed.
- Expected: Remove these buttons from the chat pane UI.
- Actual: Buttons are present and considered clutter.
- Repro steps: Open agent chat side pane.
- Notes:
- Status: unprocessed

## [2026-09-13] Default "remote"/cloud sync should be off unless explicitly enabled
- Area: client settings / session sync
- Description: Sessions were syncing to the cloud without the user noticing or opting in.
- Expected: Cloud/remote sync should default to off; user should explicitly opt in.
- Actual: Remote sync appears to default to on, syncing all sessions to the cloud silently.
- Repro steps: Fresh/default client install or config, check sync setting default and observe sessions appearing in cloud store.
- Notes: Privacy-sensitive — user didn't realize this was happening.
- Status: unprocessed

## [2026-09-15] Regression: unpinned canvas stays on top when side panel is pinned
- Area: canvas windows / side panel window management
- Description: An unpinned canvas remains always-on-top whenever the main side panel is pinned. The two windows' pin states are incorrectly coupled.
- Expected: A canvas should stay on top only when that specific canvas is pinned. Pinning the side panel should affect only the side panel.
- Actual: Pinning the side panel also makes an open, unpinned canvas stay on top.
- Repro steps: Open a canvas and leave its pin disabled; pin the main side panel; focus another application and observe that the canvas remains above it.
- Notes: Regression of the canvas/pane z-order work in commit `81ff6d0` (2026-05-19). Its `shouldCanvasBeOnTop()` policy explicitly returns true when the main side panel is pinned, but that behavior is no longer desired.
- Status: fixed locally
