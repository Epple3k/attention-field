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

### Two kinds of connection

The field draws two visually distinct relationships, and only one of them
ever uses the accent color — orange is reserved strictly for *live signal*,
neutral warm-white for *static structure*:

- **Topic clusters (neutral, persistent).** Each active article's real
  Wikipedia categories are fetched live
  (`js/categoryService.js`, via the public `action=query&prop=categories`
  API) and administrative/maintenance categories are filtered out. Any two
  articles that genuinely share a category are connected by a thin neutral
  line and drawn physically toward each other; connected components of 3+
  articles get a soft halo and a label — the actual shared category name,
  e.g. `MACHINE LEARNING` — floated over the group. This is the field's real
  topic-clustering mechanism: grounded in Wikipedia's own taxonomy, not an
  inferred or invented similarity score.
- **Event links (orange, transient).** When the same editor touches two
  different articles within 90 seconds, a fading line with a traveling pulse
  connects them — evidence of coordinated behavior (a template rollout,
  someone following a thread across pages) happening right now.

#### Merged cluster shapes

A topic cluster that grows to 4+ members physically converges and merges
into a single object — a regular polygon whose side count equals its member
count, so a hexagon really is "6 articles fused into one." Individual dots
stop being drawn; the shape's own fill/stroke brightens with its members'
combined live activity, so a burst of edits happening *inside* it is still
visible as one aggregated pulse. **Hover** it to preview a few member
titles; **click** it to expand — members physically fly back apart to their
own positions and become individually visible and clickable again. Click
the expanded halo again to re-collapse. This is the field's actual
synthesis mechanic: once there's enough evidence for a topic, the field
stops showing you N separate things and shows you one thing, with the
individual evidence still one click away.

Verified end-to-end against the live API (Node, no browser): four articles
known to share `Category:Programming languages`-adjacent categories
converged from an average ~350px spread down to ~30px while collapsed,
flew back out to ~200px on expand, and re-collapsed correctly on a second
toggle.

### Synthesis layer

Three things read the field's current topology back to you, so it's never
just a set of independent, labeled dots:

- **FOCUS**, top-center of the header — the label of whatever cluster
  currently has the most members: a one-line, live "what's going on."
- **CLUSTERS**, in the footer — how many named topic groups (3+ articles)
  exist right now.
- **Ambient field glow** — a very soft background wash whose intensity
  tracks smoothed edits/second, so the whole canvas visibly breathes with
  aggregate Wikipedia throughput, not just individual nodes.

## Architecture

```
EventStream (js/eventStream.js)
     ↓
Category Service (js/categoryService.js) ← live Wikipedia category lookups
     ↓
Article State Store (js/articleStore.js)  ← RANGE / MODE / FILTER state,
     ↓                                       edit history, clustering,
     ↓                                       event links, field energy
Physics (js/physics.js)                   ← repulsion, topic-cluster springs,
     ↓                                       event-link springs
Renderer (js/renderer.js)
     ↓
main.js — wiring, HUD, input
```

Data handling is kept fully separate from rendering. No frameworks — vanilla
HTML/CSS/JS with a `<canvas>` field.

## Status

Live connection, ~60 concurrent article nodes, pulse-on-edit, decay-when-idle,
a wheel-controlled GAIN, functional RANGE/MODE/FILTER, real Wikipedia-category
topic clustering with cluster halos/labels, merged/collapsible cluster shapes
with hover-preview and click-to-expand, same-editor event links, a
synthesis-level FOCUS readout, ambient field-energy glow, and the core visual
identity are in place. Pageview context (for genuine 24h history), trails,
sound, and deeper article inspection remain planned second-iteration
additions.
