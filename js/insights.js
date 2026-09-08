// PATTERN ENGINE — a small, self-contained heuristic that reads real
// signals already sitting in the data (edit summaries, how many distinct
// editors are involved, whether a page just appeared) and turns them into
// a short, plain-language guess at *why* a topic cluster is active right
// now. Nothing here calls out to any external service or model — it's a
// from-scratch analysis over data this app already has, deliberately kept
// separate from articleStore/physics so it can be read (and judged) as its
// own thing, the way the Index view credits it.
//
// This is explicitly a heuristic, not a verified fact: it surfaces a
// pattern in the data and says so, rather than asserting a cause.

const STOPWORDS = new Set(
  (
    "the a an and or but of to in on at for with from by is are was were " +
    "be been being this that these those it its his her their our your my " +
    "as not no yes do does did has have had will would can could should " +
    "into onto about over under again further than then once here there " +
    "all any both each few more most other some such only own same so " +
    "also new added add remove removed removing update updated updating " +
    "using use used via per see also -- - > < / * section top redirect " +
    "redirected disambiguation stub general fix fixes fixed minor major " +
    "wp wiki wikipedia www http https com org rc rv reverted revert undo " +
    "edit edits editing page pages article articles info information " +
    "changed change changes make made makes one two first second third"
  ).split(/\s+/)
);

// Strips MediaWiki edit-summary markup (section-header comments,
// [[links]], templates) down to plain words, lowercased, stopwords and
// short/numeric tokens removed.
function tokenize(comment) {
  return comment
    .replace(/\/\*.*?\*\//g, " ") // /* Section header */
    .replace(/\[\[|\]\]|\{\{|\}\}/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9'-]+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
}

/** Counts each keyword once per *node* (not per comment), so one chatty
 * editor repeating a phrase across their own edits can't manufacture a
 * false cross-article signal — a real pattern needs the word to show up
 * on separate articles. */
function extractKeywords(members) {
  const counts = new Map();
  for (const m of members) {
    const seenOnThisNode = new Set();
    for (const comment of m.recentComments || []) {
      for (const word of tokenize(comment)) seenOnThisNode.add(word);
    }
    for (const word of seenOnThisNode) counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word]) => word);
}

function distinctEditors(members) {
  const set = new Set();
  for (const m of members) for (const u of m.recentEditors || []) if (u) set.add(u);
  return set;
}

/** The main entry point: a short narrative sentence plus a confidence
 * label, for a topic cluster. Nothing here is guaranteed correct — it's a
 * heuristic reading of edit summaries, editor spread, and page-creation
 * events, presented as exactly that. */
export function generateClusterInsight(cluster) {
  const members = cluster.members;
  const n = members.length;
  const keywords = extractKeywords(members);
  const editors = distinctEditors(members);
  const totalEdits = members.reduce((s, m) => s + m.edits, 0);
  const anyNew = members.some((m) => m.everNew);

  // A shared phrase only counts as "the same real event" if it came from
  // more than one person — the same editor (or bot) repeating their own
  // summary across pages is a bulk-update signal, not a public-interest one.
  const hasIndependentKeywordSignal = keywords.length >= 1 && editors.size >= 2;

  let text;
  let confidence;

  if (anyNew && hasIndependentKeywordSignal) {
    text = `A new article just appeared in this group, and edit summaries from ${editors.size} different editors repeatedly mention ${listify(
      keywords
    )} — consistent with a specific real-world trigger rather than routine maintenance.`;
    confidence = "PATTERN: NEW ARTICLE + SHARED TERMS";
  } else if (anyNew) {
    text = `A new article just appeared alongside ${n - 1} related ${
      n - 1 === 1 ? "page" : "pages"
    } becoming active in the same window — often how breaking coverage of something not previously notable enough for its own page shows up first.`;
    confidence = "PATTERN: NEW ARTICLE";
  } else if (hasIndependentKeywordSignal) {
    text = `${n} articles under "${cluster.label}" are active right now, and edit summaries from ${editors.size} different editors repeatedly reference ${listify(
      keywords
    )} — the kind of shared, specific language that shows up when several pages are being updated in response to the same real event.`;
    confidence = "PATTERN: SHARED EDIT-SUMMARY TERMS";
  } else if (editors.size >= Math.max(3, Math.ceil(n * 0.6))) {
    text = `${totalEdits} edits across ${n} articles from ${editors.size} separate editors in a short window — a spread this wide, without one contributor dominating, usually points to independent public attention rather than a single coordinated update.`;
    confidence = "PATTERN: BROAD, INDEPENDENT EDITING";
  } else if (editors.size <= 2 && totalEdits >= n * 2) {
    text = `${totalEdits} edits across ${n} articles are concentrated among just ${editors.size} editor${
      editors.size === 1 ? "" : "s"
    } — more consistent with a bulk or template-driven update (a routine sweep, a scheduled refresh) than a wave of independent interest.`;
    confidence = "PATTERN: CONCENTRATED EDITING";
  } else {
    text = `${n} articles connected by "${cluster.label}" have picked up ${totalEdits} edits recently — not yet enough of a shared signal in the edit summaries themselves to say more than that this group is active.`;
    confidence = "PATTERN: INSUFFICIENT SIGNAL";
  }

  return { text, confidence, byline: "PATTERN ENGINE" };
}

function listify(words) {
  const upper = words.map((w) => `"${w}"`);
  if (upper.length === 1) return upper[0];
  return upper.slice(0, -1).join(", ") + " and " + upper[upper.length - 1];
}
