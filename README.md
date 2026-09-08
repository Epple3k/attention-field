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
- **Hover** a node to highlight it; **click** to open the article on
  Wikipedia.

## Architecture

```
EventStream (js/eventStream.js)
     ↓
Article State Store (js/articleStore.js)
     ↓
Physics (js/physics.js)
     ↓
Renderer (js/renderer.js)
     ↓
main.js — wiring, HUD, input
```

Data handling is kept fully separate from rendering. No frameworks — vanilla
HTML/CSS/JS with a `<canvas>` field.

## Status

Current build is the MVP: live connection, ~60 concurrent article nodes,
pulse-on-edit, decay-when-idle, one wheel-controlled parameter (GAIN), and the
core visual identity. Pageview context, trails, topic clustering, sound, and
deeper article inspection are planned second-iteration additions.
