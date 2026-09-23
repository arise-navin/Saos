/**
 * Token estimation, in one place because three layers now need it and one of
 * them cannot reach the others.
 *
 * `compaction.js` imports the provider index to run its summariser, so the
 * adapter cannot import `compaction.js` back without a cycle. The estimator is
 * the only thing it wanted, and it has no dependencies of its own — so it
 * lives here and both sides import it.
 */

/**
 * Characters per token. Deliberately pessimistic: 3.5 rather than the usual 4,
 * because tool results are JSON, and JSON tokenises worse than prose. Guessing
 * high on token count means compacting slightly early, which is cheap. Guessing
 * low means the request fails, which is not.
 */
export const CHARS_PER_TOKEN = 3.5;

/** Token estimate for a plain string — the system prompt, or serialised tools. */
export function estimateTextTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}
