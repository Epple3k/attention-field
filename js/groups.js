// High-level topic groups, purely for at-a-glance node color-coding.
// Separate from — and coarser than — the specific-category clustering in
// articleStore.js, which remains the real structural signal (ties, merged
// shapes). Groups are a supplementary identity cue, not the sole channel:
// every node's title is available as text (on hover, or once large/active
// enough to show a label), which is what the palette leans on to stay
// legible for colorblind viewers.
//
// Color choices: validated with the dataviz skill's CVD/contrast checker
// against this app's real background (#0a0a09), using its documented dark
// categorical hues, minus slot 2 (orange) — reserved elsewhere in this app
// exclusively for "live/hot" signal, so a topic group could never be
// mistaken for an active pulse. The checker's own finding is that full
// pairwise (any-two-dots-adjacent) colorblind separation tops out at 3
// hues for this hue family; a 4th (red) introduces one imperfect pair
// (red vs. yellow, ΔE 13 vs. a 15 target — a near miss, not a collision).
// That's accepted here deliberately: this is an ambient field, not a
// compliance chart, and text labels are the reliable fallback.

export const GROUPS = {
  SCI_TECH: { label: "Science & Technology", color: "57, 135, 229" }, // #3987e5
  GEO_NATURE: { label: "Geography & Nature", color: "25, 158, 112" }, // #199e70
  ARTS_CULTURE: { label: "Arts & Culture", color: "201, 133, 0" }, // #c98500
  PUBLIC_LIFE: { label: "Politics, Society & Sport", color: "230, 103, 103" }, // #e66767
  OTHER: { label: "Other", color: "138, 132, 120" }, // neutral — matches COLOR_DIM
};

const RULES = [
  {
    key: "SCI_TECH",
    pattern:
      /science|technology|computing|software|programming|engineer|mathematic|physics|chemistry|biology|medicine|internet|artificial intelligence|computer|astronomy|research|compan(y|ies)|business|industry|econom|financ|corporation|bank|stock market|trade/i,
  },
  {
    key: "GEO_NATURE",
    pattern:
      /geography|countr(y|ies)|cities|city|river|mountain|continent|capital|province|region|county|municipalit|town|village|island|border|nature|animal|species|plant|environment|wildlife|climate/i,
  },
  {
    key: "ARTS_CULTURE",
    pattern:
      /film|movie|music|album|television|actor|actress|\bartist|entertainment|celebrit|singer|\bband\b|novel|literature|theatre|video game|fashion|culture|religio|language|cuisine/i,
  },
  {
    key: "PUBLIC_LIFE",
    pattern:
      /politic|government|election|president|minister|parliament|\blaw\b|legislat|diplomat|military|\bwar\b|conflict|treaty|sport|football|basketball|baseball|olympic|tennis|cricket|athlet|championship|\bleague\b|soccer|rugby|\bgolf\b|history|historical|ancient|medieval|dynasty|empire|revolution|society|social|education|university/i,
  },
];

/** Classifies a node's category set into one high-level group by counting
 * regex matches per rule and taking the strongest; ties broken by rule
 * order above. Returns "OTHER" for an empty or unmatched set. */
export function classifyGroup(categories) {
  if (!categories || !categories.size) return "OTHER";
  const scores = new Map();
  for (const cat of categories) {
    for (const rule of RULES) {
      if (rule.pattern.test(cat)) {
        scores.set(rule.key, (scores.get(rule.key) || 0) + 1);
      }
    }
  }
  let best = "OTHER";
  let bestScore = 0;
  for (const rule of RULES) {
    const score = scores.get(rule.key) || 0;
    if (score > bestScore) {
      bestScore = score;
      best = rule.key;
    }
  }
  return best;
}
