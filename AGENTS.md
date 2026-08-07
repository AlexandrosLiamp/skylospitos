# AGENTS.md — Spitogatos "Μόνο Ιδιώτες"

Instructions for any coding agent working on this repo (Claude Code, Codex, opencode,
Cursor, or any other). `CLAUDE.md` is a one-line pointer at this file; this file is the
source of truth.

## What this is

A Chrome MV3 extension for spitogatos.gr that hides real-estate-agency listings and shows
only posts by private individuals (ιδιώτες). One toggle in the site's filter toolbar.

## Read before changing anything

- `PLAN.md` — v1 build plan and site research. Documents which selectors were validated
  against how many real listings, and **why** the DOM-icon approach was chosen over
  alternatives.
- `PLAN_V02.md` — v0.2 milestones, the API response shape, the private-listing signal
  (`enquirerId`), and the rate-limit observations behind the current chunk size and delay.

These are not background reading. The selectors and the chunk/delay numbers are load-bearing
and were derived empirically. Do not change them on a hunch.

## Layout

```
manifest.json         MV3 manifest
src/content.js        detection, hiding, observer, and the one toggle
src/styles.css        toggle button styling
src/consolidate.js    API fetch, results-column takeover, map-pin takeover
src/consolidate.css   takeover rules + notice states
icons/                16 / 48 / 128 px icons
```

`src/consolidate.js` is roughly half comments — the site research behind each decision is
written next to the code that depends on it. Keep it that way.

## How it works

The site itself already knows which listings are private: every results card renders a
different SVG icon by poster type — `#i-private-person` for individuals, `#i-crown` for
boosted agency ads, an agency-logo image for the rest. The extension reads those signals and
hides what you don't want. It does not guess.

The consolidated view builds cards carrying the site's own class names and Vue scoped-CSS
attributes, read off a live card at runtime, so the site's stylesheet draws them.
**Nothing is cloned.** Preserve that.

## Build and test

There is no build step, no bundler, no dependencies.

1. `chrome://extensions/` → Developer mode on → **Load unpacked** → select this folder.
2. Test against a real search, e.g.
   `https://www.spitogatos.gr/enoikiaseis-katoikies/nomos-artas`
3. After editing source, click the **reload arrow** on the extension's card. A page refresh
   alone does not pick up code changes — Chrome caches the loaded extension.

## Constraints

- Host permissions stay limited to `https://www.spitogatos.gr/*`.
- Storage: one boolean in `chrome.storage.sync`, learned label vocabulary in
  `chrome.storage.local`. Nothing else.
- No telemetry. No background worker. The only network requests are the consolidated view's
  calls to spitogatos.gr's own API, and only while the toggle is on. Do not add others.
- Bump `version` in `manifest.json` when behaviour changes.

## Git & GitHub

**Never credit yourself on a commit.** No agent, model, or vendor may appear as an author or
co-author of anything pushed to GitHub.

- **No** `Co-Authored-By:` trailer naming any AI tool or model, on any commit.
- **No** "🤖 Generated with Claude Code", "Generated with Codex", or any other AI or vendor
  credit in commit messages, PR bodies, releases, or the README.
- Commits are authored by the repo's configured identity only (`AlexandrosLiamp`) — never
  override `user.name` / `user.email`.
- Commit messages describe the change and nothing else.
- **Push only when the user asks.**

## Note

This repo is public. `.claude/` is gitignored on purpose and holds only generic third-party
skills — no project instructions live there.
