// Connects to Wikimedia EventStreams and emits normalized edit events
// for the English Wikipedia article namespace only.

const STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange";

// Namespace 0 = mainspace (articles). Everything else (Talk, User, File,
// Category, Wikipedia:, etc.) is noise for a field of "articles".
const ARTICLE_NAMESPACE = 0;

/**
 * @param {object} handlers
 * @param {(edit: object) => void} handlers.onEdit
 * @param {() => void} [handlers.onOpen]
 * @param {(err: Event) => void} [handlers.onError]
 * @returns {() => void} disconnect function
 */
export function connectStream({ onEdit, onOpen, onError }) {
  const source = new EventSource(STREAM_URL);

  source.onopen = () => onOpen && onOpen();

  source.onmessage = (event) => {
    let change;
    try {
      change = JSON.parse(event.data);
    } catch {
      return;
    }

    if (change.server_name !== "en.wikipedia.org") return;
    if (change.namespace !== ARTICLE_NAMESPACE) return;
    if (change.bot) return;
    if (change.type !== "edit" && change.type !== "new") return;
    if (!change.title) return;

    onEdit({
      title: change.title,
      type: change.type,
      user: change.user,
      timestamp: (change.timestamp || Date.now() / 1000) * 1000,
      isNew: change.type === "new",
      minor: !!change.minor,
      lengthDelta: change.length
        ? (change.length.new || 0) - (change.length.old || 0)
        : 0,
      comment: change.comment || "",
      url:
        change.meta && change.meta.uri
          ? change.meta.uri
          : `https://en.wikipedia.org/wiki/${encodeURIComponent(
              change.title.replace(/ /g, "_")
            )}`,
    });
  };

  source.onerror = (err) => onError && onError(err);

  return () => source.close();
}
