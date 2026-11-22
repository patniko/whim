# whim — Interactive Walkthrough

A web-based, interactive slide deck that walks new users through whim. Each slide pairs
short copy with a **live, clickable simulated UI mockup** (no real app or backend required), built
on [Reveal.js](https://revealjs.com/).

## Sections

1. Welcome / overview
2. Setup process — global hotkey, choose a workspace, sign in with GitHub
3. Creating a Space — capture by typing/voice, AI refinement
4. Built-in agents — the seeded personas (`@agent`, `@editor`, `@dev`, `@pr`, `@cloud`, `@secret-agent`, `@sandbox`)
5. Commenting to agents — select text → comment → @mention → reply
6. Standalone agents — `+ New Agent`, Workers tab, live steps & approvals
7. Creating skills — `SKILL.md` editor with live preview
8. Scheduling skills — frequency/time picker + next-run
9. Spaces as a todo list — status flow + logged activity timeline
10. Wrap-up + keyboard shortcuts

## Run it

```bash
cd walkthrough
npm install          # installs reveal.js
npm start            # serves at http://localhost:4321
```

Then open <http://localhost:4321> in a browser. Any static file server works too — the deck is
fully static.

### Navigation

- `→` / `Space` — next · `←` — previous
- `Esc` — slide overview · `F` — fullscreen
- `S` — speaker notes · `?` — keyboard help

## How it's built

```
walkthrough/
├── index.html            # Reveal.js deck; one <section> per slide, widget mount points
├── serve.js              # zero-dependency static server (npm start)
├── css/
│   ├── whim-theme.css     # deck theme matching whim's look
│   └── mockups.css        # shared fake-UI components (window chrome, badges, buttons…)
└── js/
    ├── deck.js            # Reveal init; lazy-loads + (re)initializes mockups per slide
    └── mockups/           # one interactive widget per module
        ├── setup.js
        ├── capture.js
        ├── personas.js
        ├── canvas-comment.js
        ├── standalone-agent.js
        ├── skill-editor.js
        ├── scheduler.js
        └── spaces-board.js
```

### Widget contract

Each mockup module exports `init(el)`, called every time its slide is shown (so animations restart
cleanly). Widgets are pure vanilla JS/DOM, reuse the shared classes in `css/mockups.css`, and inject
their own scoped styles. `js/deck.js` maps each `.mockup[data-mockup]` container to its module.

All behavior is **simulated** for teaching — the deck does not talk to the real Electron app.

## Deploying to GitHub Pages

The deck is static, but it imports Reveal from `node_modules/`, so `node_modules/reveal.js/` must be
present in what you publish. Two options:

- Commit `walkthrough/node_modules/reveal.js/` (or vendor its `dist/` folder), then point Pages at
  `walkthrough/`; or
- Run `npm install` in a build step before publishing the folder.
