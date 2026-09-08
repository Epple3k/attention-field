# ATTENTION FIELD

A live data-art instrument that visualizes real-time editorial activity across
English Wikipedia as a physical field of signals.

Not a trending-topics dashboard. An investigation into what collective human
attention looks like when treated as a live physical system — articles pulse,
drift, resonate, and decay as edits happen, in real time, in front of you.

## Running locally

Any static file server works. For example:

```
python -m http.server 8000
```

Then open `http://localhost:8000`.

The page connects directly to the public
[Wikimedia EventStreams](https://stream.wikimedia.org/v2/stream/recentchange)
endpoint from the browser — no backend required.

## Interaction

- **Scroll / trackpad wheel** over the field adjusts **GAIN** — how strongly
  each incoming edit affects the visualization.
- **Scroll or click** RANGE, MODE, or FILTER in the footer to step through
  their values, like a selector switch on an instrument.
- **Hover** a node to highlight it; **click** to open the article on
  Wikipedia.

### RANGE, MODE, FILTER

- **RANGE** (1M / 5M / 15M / 1H) sets the field's memory span. It controls
  both how long a node's activity lingers before decaying (short range =
  snappy and immediate, long range = slow and settled) and the window used
  to count each node's recent edits.
- **MODE** switches the lens on that same data: **ACTIVITY** shows the
  instantaneous pulse of what's happening right now; **VOLUME** sizes nodes
  by accumulated edit count within the current RANGE, giving a steadier,
  longer-term read on which articles are under sustained attention rather
  than a single momentary spike.
- **FILTER** (ALL / NEW / MAJOR / MINOR) gates which incoming edits are
  allowed to register at all — NEW shows only page creations, MAJOR only
  substantial rewrites (±500 characters), MINOR only edits flagged minor by
  the editor.

There's no historical Wikipedia API involved in RANGE/MODE — "long-term"
here means accumulated *within this browser session*, since that's the only
history the live stream itself provides. A true 24h view would require
pulling in the Pageviews API (see Second iteration, below).

### Association lines

When the same editor touches two different articles within 90 seconds, a
thin line is drawn between their nodes with a traveling pulse — real,
verifiable connective tissue in the data (a template rollout, someone
following a thread across pages, a coordinated topic sweep), not an inferred
or decorative one. Linked nodes also drift gently toward each other while
the link is fresh, standing in for topic clustering without needing external
semantic data.

## Architecture

```
EventStream (js/eventStream.js)
     ↓
Article State Store (js/articleStore.js)  ← RANGE / MODE / FILTER state,
     ↓                                       edit history, editor links
Physics (js/physics.js)
     ↓
Renderer (js/renderer.js)
     ↓
main.js — wiring, HUD, input
```

Data handling is kept fully separate from rendering. No frameworks — vanilla
HTML/CSS/JS with a `<canvas>` field.

## Status

Live connection, ~60 concurrent article nodes, pulse-on-edit, decay-when-idle,
a wheel-controlled GAIN, functional RANGE/MODE/FILTER, same-editor
association links, and the core visual identity are in place. Pageview
context (for genuine 24h history), trails, sound, and deeper article
inspection remain planned second-iteration additions.
