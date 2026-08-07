# Canvas reports

A **canvas report** is the durable, visual output of a skill run: a self-contained
HTML page stored in the space that produced it, openable from the space list, the
tray, or a notification — days later, without the agent still being around.

It exists to close a specific gap. Whim could already define a skill, run it on a
schedule, and give it a space to work in, but the result of that work landed in a
chat transcript nobody goes back to read. A scheduled skill whose output is
invisible is a scheduled skill you eventually turn off.

## Two things called canvas

Whim has a **markdown canvas** — the `canvas.md` document at the heart of every
space, edited in Milkdown. That is unrelated to what this document describes.

A **canvas report** uses the Copilot SDK's *canvas* concept: a host-provided
surface an agent discovers through `list_canvas_capabilities` and drives with
`open_canvas` and `invoke_canvas_action`. Whim is the host, so whim registers the
canvases and renders them.

## The shape of a run

```
skill  →  scheduler  →  space  →  agent run  →  report  →  one click to open it
```

1. A skill opts into reports in its `SKILL.md` frontmatter.
2. The scheduler invokes it, or the user runs it by hand.
3. The run gets a space — reused from the last run by default, so a daily skill
   leaves one space rather than a hundred.
4. Whim registers a canvas on that run only, and appends an explicit obligation
   to publish a report.
5. The agent writes its output and publishes it.
6. The space row grows a chip, the tray lists the report, and a notification
   fires if the run was unattended.

## Enabling reports on a skill

Two frontmatter fields in `SKILL.md`:

```yaml
---
name: Look for open questions
description: Finds questions still waiting on you and reports them.
schedule: weekdays
schedule_time: "08:30"
canvas: true
space_mode: reuse
---
```

| Field | Values | Meaning |
|---|---|---|
| `canvas` | `true`, `false`, or a template id | Whether the run may produce a report, and which layout it uses. |
| `space_mode` | `reuse`, `new` | Whether repeat runs refresh one space or each get their own. |

`space_mode` defaults to `reuse` for canvas skills and `new` for everything else.
A reused space that the user has completed is reopened, and the run is told what
the previous report contained so it refreshes rather than starting from scratch.

There is a worked example in
[`examples/skills/look-for-open-questions/`](../examples/skills/look-for-open-questions).
Copy the folder into `<workspace>/.agents/skills/` to try it.

## Where reports live

```
<space folder>/reports/<artifactId>/
  manifest.json   title, status, binding, content hash
  index.html      the published report
  data.json       optional structured payload
```

Disk is the source of truth. Nothing about a report lives only in the database,
so it survives a projection rebuild, a workspace moved to another machine, and
the agent session that produced it going away.

The location is deliberately outside the space's `.whim/` directory, which is
gitignored. Whim auto-commits the workspace, so reports under `reports/` are
versioned by git and travel with a synced workspace — a report stored somewhere
git ignores would be missing on every other machine, leaving a chip pointing at
a file that is not there.

## Writing the report

By default a run uses the built-in `whim-report` canvas and writes the HTML
itself. The instruction contract whim appends tells it to:

1. Write a self-contained HTML file inside the space folder.
2. `open_canvas` with a title.
3. `invoke_canvas_action` with `publish`, passing the file path relative to the
   space folder plus a `title` and a short `status`.
4. Not finish until `publish` succeeds.

Two failure modes are called out explicitly, because both are worse than they
look: finishing without publishing (indistinguishable from a crashed run) and
finishing after a failed publish (a chip that opens nothing).

Content passes **by reference** — a path, never inline HTML. The runtime persists
action input in durable session events and replays it on reconnect, so shipping
whole documents through the RPC would store and replay them on every restart.

An explicit `artifactId` must already be lowercase letters, digits and hyphens;
it is rejected rather than slugified, because slugifying makes `Q&A` and `Q A`
the same report and one would silently overwrite the other. A `title` has no
such expectation and is slugified as before.

## Shipping a template with a skill

A skill can supply its own layout instead, so the model provides findings and
whim renders them:

```
.agents/skills/<slug>/canvas/
  canvas.json      definition
  template.html    markup with {{tokens}}
```

`canvas.json`:

```json
{
  "id": "open-questions",
  "displayName": "Open questions",
  "description": "Questions still waiting on you.",
  "template": "template.html",
  "data": {
    "headline": "One line summarising the sweep.",
    "groups": [{ "name": "Group heading.", "items": [{ "question": "What is being asked." }] }]
  }
}
```

The optional `data` block documents the shape your template expects, and whim
puts it in front of the model as part of the canvas description. It is worth
filling in: the model never sees the template file, so without it the token
names are a guess and the report renders blank. Write prose in the values —
they describe the field, they are not example data. Shapes over 8 KB are
dropped rather than allowed to flood the prompt.

Then point the skill at it:

```yaml
canvas: open-questions
```

Whim exposes the canvas as `skill.<skill-id>.<template-id>`, because independently
written skills will otherwise collide on names like `report`. The run's contract
changes accordingly: the agent writes a JSON file and calls `render` with its
path, and is told not to write HTML.

### Template syntax

Two constructs:

- `{{token}}` — a value. Dotted paths (`{{summary.count}}`) work. A token with no
  matching data renders empty rather than leaving `{{token}}` visible in the
  report.
- `{{#list}}…{{/list}}` — repetition over an array, or a conditional when the
  value is not an array. Inside a repetition, `{{.}}` is the item itself and the
  surrounding scope is still readable.

That is the whole language, on purpose. Anything richer, driven by model output,
is a liability rather than a feature.

**Every substituted value is HTML-escaped.** This matters more than it appears:
report content is a model's summary of third-party messages, so markup can arrive
from a Slack quote or an issue title as easily as from the model itself.

## Opening a report

- **Space list** — a chip on the row of any space with a published report.
- **Tray** — a Reports section listing reports from spaces you have not completed.
- **Notification** — fires only when a run published something new. A scheduled
  skill that found nothing stays silent; a manual run you are watching does not
  notify, because its window is already in front of you.

Scheduled runs never steal focus, and never open a window at all — an unread
report should not cost a renderer process. The point of scheduling is that you
are elsewhere.

If a run finishes owing a report and never files one, it says so: the worker
reads "Completed without a report" rather than a plain "Completed", which would
be indistinguishable from success.

## Security model

Reports are agent-authored documents and are treated as untrusted input.

- **Isolated origin.** Reports are served from a dedicated `whim-artifact://`
  scheme with its own Electron session partition — never from `copilot-whim://`,
  which serves the app and holds its tokens.
- **No scripts, no network.** The CSP is `default-src 'none'` with narrowly
  allowed inline styles and local images. Scripts, remote fonts, stylesheets and
  images do not load.
- **No bridge.** Report windows run with `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false` and no preload, so there is no IPC surface to reach.
- **Confined paths.** Publishing resolves through `fs.realpath` and rejects
  anything that escapes the space folder, including symlinks and encoded
  traversal. The same applies to the artifact directory itself and to a skill's
  template: the agent can write anywhere in its own workspace, so it can leave a
  symlink and let whim — not the sandboxed agent — do the reading or writing.
  Report files are always written temp-and-rename, which replaces a symlink
  sitting at the target rather than writing through it.
- **Size limits.** 5 MB for a report, 1 MB for its data payload.
- **External links** open in the system browser, but only from a window you are
  actually looking at, and only for `http(s)`. In-window navigation, redirects
  and downloads are blocked, and `<meta http-equiv="refresh">` is stripped when
  the report is served — with scripts already blocked, it was the one way an
  agent-authored page could navigate itself with nobody involved.

Canvas tools prompt for permission like any other custom tool, with one narrow
exception: `list_canvas_capabilities`, `open_canvas` and `invoke_canvas_action`
are pre-approved for **scheduled** runs, which would otherwise stall forever
waiting for a user who is not there. The list is explicit rather than a pattern
match, so a future tool with "canvas" in its name is not silently approved. The
grant lasts only as long as the unattended run: it is dropped when the run
finishes and is not restored when you resume a finished session, because from
then on somebody is driving.

## Implementation map

| File | Responsibility |
|---|---|
| `src/main/canvas/artifact-store.ts` | Durable store; manifests, atomic publish, confinement |
| `src/main/canvas/artifact-protocol.ts` | The `whim-artifact://` scheme and its CSP |
| `src/main/canvas/artifact-window.ts` | Hardened report windows |
| `src/main/canvas/sdk-canvas-provider.ts` | The built-in `whim-report` canvas |
| `src/main/canvas/skill-canvas-template.ts` | Template loading and rendering |
| `src/main/canvas/skill-canvas-provider.ts` | Canvas backed by a skill's template |
| `src/main/canvas/canvas-policy.ts` | Which runs may produce reports |
| `src/main/canvas/canvas-session.ts` | The single seam onto the SDK canvas API |
| `src/main/canvas/canvas-launch.ts` | Per-run wiring, window hooks |
| `src/main/canvas/canvas-lifecycle.ts` | Instance ↔ window reconciliation |
| `src/main/canvas/canvas-outcome.ts` | What a run actually published |
| `src/main/canvas/canvas-notifier.ts` | Whether the user hears about it |
| `src/main/canvas/space-location.ts` | Resolving a session back to its space folder |
| `src/main/services/skill-space-reuse.ts` | Refresh a space instead of piling them up |
