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
- **Scroll or click** RANGE, MODE, or FILTER in the control bar (directly
  below the header — there's no bottom footer anymore) to step through
  their values, like a selector switch on an instrument.
- **Hover** a node for its context summary — title plus a plain-language
  explanation, in a large, high-contrast backed panel, not small text
  floating loose. Hovering also stabilizes that node (and its direct
  ties) so it holds still long enough to actually read, without pushing
  anything else in the field around — see Physics, below. **Click** to
  open the article on Wikipedia; **drag** to pull it — release to throw
  it back into the simulation.
- **Hover** an association tie (the thin lines between nodes) to see why
  the two articles are connected; **click** to pin that focus open.
- **Hover** a merged cluster shape for a preview of its members; **click**
  to open it into individual nodes.
- **Click the INDEX tab**, or scroll horizontally over the field (a
  trackpad two-finger swipe, shift+wheel, or a mouse's tilt-wheel), to
  switch to the Index — the same live data as a scrollable text hierarchy.
  See Index view, below.

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
  articles get a dashed boundary — a convex hull around their actual current
  positions, not a glow — plus a label: the actual shared category name,
  e.g. `MACHINE LEARNING`, floated over the group. This is the field's real
  topic-clustering mechanism: grounded in Wikipedia's own taxonomy, not an
  inferred or invented similarity score.
- **Event links (orange, transient).** When the same editor touches two
  different articles within 90 seconds, a fading line with a traveling pulse
  connects them — evidence of coordinated behavior (a template rollout,
  someone following a thread across pages) happening right now.

Both kinds of tie are real interactive targets, not decorative geometry.
Hovering one thickens it, highlights both endpoint nodes, dims everything
else in the field to a third of its normal opacity, and shows a plain-
language explanation — "X and Y are both categorized under Z" for a topic
tie, or "user U edited both X and Y within the last 90 seconds" for an
event tie. Clicking pins that focus open so it survives the mouse moving
away; clicking the same tie again, or anywhere else in the field, releases
it.

#### Merged cluster shapes

A topic cluster that grows to 4+ members physically converges and merges
into a single object — a regular polygon whose side count equals its member
count, so a hexagon really is "6 articles fused into one." Individual dots
stop being drawn; the shape's own fill/stroke brightens with its members'
combined live activity, so a burst of edits happening *inside* it is still
visible as one aggregated pulse. Nothing else in the field dims or greys
out when this happens — it's one new object appearing, not a modal state.

**Hover** it — the shape lifts slightly and gains an outer ring, and a
preview of a few member titles appears beneath it. **Click** it to expand:
members get a real outward velocity kick and physically shove aside
whatever else is nearby, the way an edit pulse displaces its neighbors,
then settle into their own positions as individually visible, clickable
nodes again. To close it, **click anywhere outside its boundary** — same
as dismissing a popover; clicking among its own members (or on one, to open
it) leaves it open. This is the field's actual synthesis mechanic: once
there's enough evidence for a topic, the field stops showing you N separate
things and shows you one thing, with the individual evidence still one
click away.

Verified end-to-end against the live API (Node, no browser): four articles
known to share `Category:Programming languages`-adjacent categories
converged from an average ~350px spread down to ~30px while collapsed,
flew back out to ~200px on expand, and re-collapsed correctly on a second
toggle.

#### No glow, anywhere

Every gradient-based glow — the old ambient field wash, the halo around an
expanded cluster, the radial bloom around a hot node — has been removed.
The field is flat color on a plain background now; the only things that
still change with live activity are hue (blending toward the accent as a
node heats up), size, and motion. The one thing a removed glow used to do
that still matters — making an expanded cluster's membership legible once
its dots have burst apart and could otherwise get lost among unrelated
nodes — is now handled by an actual geometric boundary: a convex hull
(`geometry.convexHull`, Andrew's monotone chain) computed from the
cluster's live member positions every frame, inflated a little past each
node, and drawn as a thin dashed line. It tracks the real shape of the
group, however it's scattered, rather than a fixed-size, faded-edge
territory that only loosely corresponded to where the members actually
were.

## Physics

The field's motion comes entirely from a small set of real forces in
`js/physics.js`, applied every frame to velocity — nothing (aside from a
last-resort off-screen safety clamp) ever assigns a node's position
directly, and no node has a fixed "home" position pulling it back into
place. Whatever spatial structure appears — a topic cluster sitting apart
from unrelated articles, a pulled-apart pair drifting back together — is a
real consequence of the forces below, not a pre-assigned layout.

All tunable values live in one place, `PHYSICS` in `js/physics.js` (fields
match the shape suggested during design: `associationStrength`,
`summaryAttraction`, `repulsionStrength`, `collisionStrength`,
`centeringStrength`, `dampingHalfLife`, `velocityLimit`, and so on) — no
magic numbers scattered through the force code itself.

Two tuning passes so far, each in response to it feeling wrong in an
opposite direction:

**Pass 1** — too energetic; hovering, clicking, or dragging a specific
node felt like chasing a moving target. Every attraction force and the
global `velocityLimit` were scaled down together, rather than just capping
top speed, so the whole field read as calmer rather than merely clamped.

**Pass 2** — still too bouncy and reactive: collision was a pure spring
(a positional push with no way to resist rebound), so contact between
nodes read as an elastic bounce, and there was no way to stabilize a
specific area of the field to actually read a label without nearby nodes
drifting through it. This pass:

- **Softened collision into a damped squish rather than a spring.**
  `applyCollision` still pushes overlapping bodies apart, but far more
  mildly than before (`collisionStrength` 900 → 260); the real work is
  `dampClosingVelocity`, which removes most of two bodies' *closing*
  velocity on contact (`collisionDamping: 0.88`) rather than relying on
  the positional push to eventually cancel it out. Verified directly: two
  nodes sent toward each other at a 120px/s combined closing speed come to
  rest at the collision boundary with a post-contact rebound of ~0.4px/s —
  effectively none. The same closing-velocity damping (much lighter,
  `repulsionDamping: 0.25`) was added to ordinary repulsion too, so it can
  never read as springy either.
- **Cut general damping half-life and the velocity ceiling further**
  (`dampingHalfLife` 0.49s → 0.28s, `velocityLimit` 120 → 70px/s) so
  displaced nodes lose speed faster and nothing can cross the field in a
  blur.
- **Capped every pairwise force's per-frame effect**
  (`maxPairForce: 55`) so forces move nodes gradually — no single frame's
  worth of overlap or spring tension can produce a sudden jolt, however
  large the underlying displacement is.
- **Added hover stabilization** — see below — which is what actually
  solves "reading a label near a hovered node was hard because nearby
  nodes kept moving," rather than just turning down the whole field's
  energy further (which would fight the still-explicit "don't make it
  static" requirement).

Collision strength itself was still deliberately kept meaningfully
positive (not reduced to near-zero) — a gentler field still needs a firm
"never overlap" guarantee, which is now collisionDamping's job as much as
collisionStrength's.

### Hover stabilization

Hovering a node is now a real, if temporary, change to the simulation —
not a rendering-only effect layered on top of physics that doesn't know
about it. Every node carries a `stability` value (0→1) that eases toward
1 for whichever node is hovered, a partial value (`stabilityNeighborFactor:
0.45`) for anything directly tied to it, and 0 for everything else —
fast to ease in (`stabilityInTau: 0.12s`, so it feels immediate), slower
to ease out (`stabilityOutTau: 0.7s`, so releasing the pointer doesn't
instantly let the field go).

Critically, stability does *not* work by adding a new force — the brief
said hovering must never introduce a new repulsion, and it doesn't. It
works by temporarily raising that node's effective mass
(`bodyMass = 1 + stability * stabilityMass`, up to ~46× at full
stability) and by shortening its own damping half-life
(`stabilityDampingFactor: 7`). Since every pairwise force in the system
(springs, summary gravity, repulsion, collision) already splits its effect
between two bodies by their relative mass, a stabilized node simply
absorbs almost none of whatever force reaches it — its neighbor absorbs
the rest, same as it always would. Nothing new pushes on anyone.

Verified directly against the store: hovering a node cuts its displacement
from an identical nearby disturbance by more than half compared to
unstabilized; a directly-tied neighbor picks up partial (not full)
stability; a genuinely unrelated node's stability stays exactly 0 and it
drifts less than 5px from hovering alone; and stability takes on the order
of 2 seconds to fully ease out after the pointer moves away, rather than
dropping in one frame.

Force hierarchy, strongest to weakest:

1. **Association springs** — every topic tie and event tie is a real
   Hooke's-law spring: pulls together when farther than its rest length,
   pushes apart when closer, so a torn-apart tied pair visibly drifts back
   rather than just stopping being repelled. A tie's strength (mapped
   through a restrained 0.28–1 scale, never used raw) sets both how hard it
   pulls and how short its rest length is — a rarer, more specific shared
   category, or a very fresh event tie, pulls harder and tighter.
2. **Summary gravity** — a collapsible cluster gets its own physics body: a
   real entity with position, velocity, and a mass that grows with member
   count (so bigger clusters feel heavier, slower to perturb). Members are
   pulled toward it mildly while expanded (organizing them loosely around
   it without swallowing them to a point) and strongly while collapsed
   (pulling them into the merged shape).
3. **Local repulsion** — soft, short-range personal space between every
   node and every cluster body.
4. **Collision** — a stiffer, shorter-range correction that reliably wins
   over every attraction in the system at close range, so nothing visibly
   overlaps once things settle.
5. **Weak global centering** — a very weak pull toward the field's center,
   deliberately far weaker than the association springs, that exists only
   to keep the whole field from drifting off-screen over time.
6. **Damping** — expressed as a half-life in seconds (frame-rate
   independent, not a per-frame multiplier), tuned so a displaced tie
   overshoots its rest length once, gently, before settling over a couple
   of seconds — not an instant snap, not runaway oscillation.

Interactions inject real energy rather than being scripted: dragging a
node and releasing it throws it with the actual velocity of the drag
motion; opening a cluster gives every member a real outward kick and
shoves nearby nodes aside (`displaceNeighbors`, the same mechanic a live
edit pulse uses); activating a tie nudges both endpoints. Each of these
also briefly extends the damping half-life (`energyBoostHalfLife`), so the
graph keeps visibly resettling afterward instead of snapping still.

This was verified end-to-end against the real store and the live Wikipedia
API (not just eyeballed, since this environment has no working browser
connection): a strongly-tied pair dragged apart to 600+px recovered to
within ~40px of its ~77px rest length within 3 seconds; a 4-member topic
cluster settled measurably closer to its own members than to an unrelated
control article; members stayed 40+px from their cluster's body center
while expanded rather than collapsing onto it; and no pairwise node overlap
remained after a 5-second settle.

### Topic groups

Every node is also colored by one of four high-level groups — **Science &
Technology**, **Geography & Nature**, **Arts & Culture**, **Politics,
Society & Sport** — classified from its already-fetched Wikipedia
categories by keyword rule (`js/groups.js`), with a plain neutral color for
anything that doesn't match. This is a coarser, purely-visual layer on top
of the real per-category clustering above — it doesn't drive any physics —
so an at-a-glance "what kind of thing is this" reading doesn't require
zooming into individual category labels. A hot node's color still shifts
toward the accent orange as it heats up with live activity, so hue reads
identity and warmth still reads liveness; a legend for the four colors sits
in the field's bottom-right corner.

The four hues (plus the neutral fallback) were chosen with the `dataviz`
skill's palette validator run directly against this app's real background —
originally dark (`#0a0a09`), re-validated against the current light
background (`#f7f6f2`) when the field's whole theme flipped (see Visual
system, below), since the method's lightness bands differ by surface. On
the light surface all four hues (blue, aqua, yellow, red) clear every hard
gate for full pairwise separation (worst normal-vision ΔE 20.8 against a 15
floor) — better than the dark-mode result, which had one near-miss pair.
Two WARN-tier notes remain, both legal per the method given a relief
channel: a CVD floor-band pair, and low mark-contrast specifically for aqua
and yellow as small filled dots — mitigated the same way in both cases, by
the text label every node already carries on hover or once large/active
enough. Group color here is a supplementary identity cue, not the only way
to tell a node apart — unlike a real chart, where it would need to be.

## Visual system

The field runs on a warm-white/near-black palette rather than the reverse —
chosen so the flat, categorically-colored node dots (see Topic groups)
read as the brightest, most saturated things on screen, the way colored
pins pop against a paper map. Every other UI surface (the header, the
control bar, the Index view) shares the same tokens. The one deliberate
exception is the hover context panel (node/cluster/tie), which inverts to
a dark plate with light ink — a common, legible callout convention that
makes it pop against a busy light field rather than blending into it. Text
contrast was checked, not assumed: body ink sits at 16.9:1 on the field
background, secondary ink at 6.0:1, and the accent (used for live-signal
text like the FOCUS readout) was deliberately darkened during this pass
from an initial `#d9660a` (3.3:1) to `#b85406` (4.5:1) to clear the normal
text contrast threshold rather than only the large-text one.

### Synthesis layer

Two things read the field's current topology back to you, so it's never
just a set of independent, labeled dots:

- **FOCUS**, top-center of the header — the label of whatever cluster
  currently has the most members: a one-line, live "what's going on."
- **CLUSTERS**, in the control bar — how many named topic groups
  (3+ articles) exist right now.

The deeper version of "read the topology back to you" is the Index view
and its Pattern Engine, below — going from *what* is clustered to a
heuristic guess at *why*.

## Index view

A second, full view of the same live data — not a different dataset, the
same store, presented as a scrollable text hierarchy instead of a physical
field. Reach it by clicking the **INDEX** tab next to the control bar, or
by scrolling horizontally anywhere over the field (a trackpad two-finger
swipe, shift+wheel, or a mouse's horizontal/tilt wheel — checked via the
wheel event's `deltaX`, so it doesn't compete with GAIN's vertical scroll
or the Index list's own normal vertical scrolling).

Structure: **topic group → topic cluster → articles**, in that order —
the same four coarse groups as the field's node coloring, then within each
group the same specific-category clusters as the field's merged shapes
(3+ members), then individual articles sorted by edit count, with anything
not yet in a named cluster listed separately under "Ungrouped." It rebuilds
from the live store every ~1.5s while visible (DOM writes are far more
expensive than canvas redraws, so it doesn't run every frame, and it
doesn't run at all while the Field tab is the one showing), preserves
scroll position across rebuilds, and clicking any article opens it on
Wikipedia — the same information as the field, organized for reading
instead of watching.

### Pattern Engine

Every cluster in the Index gets a short, plain-language paragraph guessing
at *why* it's active right now — the same job a human analyst does when
they notice several related pages all being edited at once and go looking
for a reason. It's a real, from-scratch heuristic (`js/insights.js`),
attributed in the UI as its own named subsystem ("— PATTERN ENGINE · " plus
which pattern it matched) rather than folded silently into the rest of the
app, and it reads signals already sitting in the data that nothing else in
this app was using:

- **Edit summaries.** Every registered edit's comment is kept
  (`node.recentComments`, bounded). Comments are stripped of MediaWiki
  markup, tokenized, and a stopword list removes both ordinary English
  filler and Wikipedia-editing boilerplate ("stub," "redirect," "using,"
  "wp"). A keyword only counts if it shows up on *more than one article* in
  the cluster — one editor repeating their own phrase across pages doesn't
  qualify, which matters for the next point.
- **How many distinct editors are involved**
  (`node.recentEditors`), which is what separates two narratives that would
  otherwise look identical from edit *volume* alone: a shared keyword
  appearing across several different editors' summaries reads as
  independent people reacting to the same real event; a shared keyword (or
  just a lot of edits) concentrated in one or two editors reads as a bulk
  or template-driven update instead. An earlier version of this engine
  didn't make that distinction and misread a single bot repeating an
  identical summary across three pages as "shared event language" — caught
  by testing the engine against a synthetic bulk-update scenario
  specifically built to expose it, not live traffic.
- **Whether a new page just appeared** (`node.everNew`) — often how
  breaking coverage of something not previously notable enough to have its
  own article first shows up.

Five scenarios (a shared-keyword event across independent editors, a
single-editor bulk update, broad independent editing with no shared
language, a new page plus a shared keyword, and a genuinely sparse
cluster) were run directly through the engine to confirm each produces a
distinct, honest read rather than a generic fill-in-the-blank sentence —
including confirming the "not enough signal yet" case says exactly that
instead of inventing a pattern. The soccer-transfer-news style example this
feature was scoped around — several player pages active at once, edit
summaries repeatedly mentioning transfers and signings — is close to
verbatim what the engine produces when the same shape of data is fed to it.

This is a heuristic over real data, not a verified fact or a call to any
external model or service — it says what pattern it matched and lets you
judge it, the same way the rest of this app prefers a real, inspectable
signal over an invented one.

## Architecture

```
EventStream (js/eventStream.js)
     ↓
Category Service (js/categoryService.js) ← live Wikipedia category lookups
     ↓
Article State Store (js/articleStore.js)  ← RANGE / MODE / FILTER state,
     ↓                                       edit history, clustering,
     ↓                                       cluster bodies, event ties,
     ↓                                       drag/energy state, field energy
Physics (js/physics.js)                   ← the force model: association
     ↓                                       springs, summary gravity,
     ↓                                       repulsion, collision, centering,
     ↓                                       damping — see Physics, above
Geometry (js/geometry.js)                 ← shared radius/strength formulas
     ↓                                       used by physics, the store, and
     ↓                                       the renderer alike
Groups (js/groups.js)                     ← high-level topic classification
     ↓                                       + validated color palette
Insights (js/insights.js)                 ← Pattern Engine — heuristic
     ↓                                       "why is this active" narratives
Renderer (js/renderer.js)                    from edit summaries + editor spread
     ↓
main.js — wiring, HUD, input, drag + tie interaction, view switching,
          Index-view rendering
```

Data handling is kept fully separate from rendering. No frameworks — vanilla
HTML/CSS/JS with a `<canvas>` field for the Field view, plain DOM for the
Index view.

## Status

Live connection, ~60 concurrent article nodes, pulse-on-edit, decay-when-idle,
a wheel-controlled GAIN, functional RANGE/MODE/FILTER in a compact control
bar, real Wikipedia-category topic clustering with a live hull boundary
(no glow anywhere in the app), a damped soft-collision spring/repulsion/
centering physics model with per-node hover stabilization (see Physics)
with draggable nodes and interactive association ties (hover for a large,
legible explanation panel, click to pin), merged/collapsible cluster
shapes with real burst-and-resettle physics, same-editor event links,
high-level topic-group color coding with a legend, a synthesis-level FOCUS
readout, a full second Index view of the same live data as a text
hierarchy with a from-scratch Pattern Engine generating a "why is this
active" narrative per cluster, and a light/near-black visual identity
(re-validated for contrast and colorblind safety on the new surface) are
in place. Pageview context (for genuine 24h history), trails, sound, and a
richer article-inspection panel remain planned second-iteration additions.
