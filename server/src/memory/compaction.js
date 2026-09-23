import { getDb } from './db.js';
import { log } from '../logging.js';
import { loadHistory, loadDigests, replaceSpanWithDigest } from './sessions.js';
import { chatOnce } from '../agent/providers/index.js';
import { codegenDecoding } from '../agent/decoding.js';
import { CHARS_PER_TOKEN, estimateTextTokens } from './tokens.js';

/**
 * A-3 — compaction.
 *
 * A long session eventually exceeds the model's context. The naive fix is to
 * drop the oldest turns, which loses exactly the thing the agent is most often
 * asked for later: the sys_id of something built twenty turns ago.
 *
 * So the oldest span is SUMMARISED into a structured digest — artifacts and
 * their sys_ids, decisions, open threads — and spliced back as a system-side
 * note, while the last K turns stay verbatim.
 *
 * Budget note, specific to this build: gpt-oss:120b-cloud advertises a 131,072
 * token context but bills hidden REASONING tokens against the same budget, and
 * the adapter's specific-error ("the max_tokens budget was exhausted before any
 * output was produced") fires when they crowd out the completion. That error
 * must never fire during compaction — a failed compaction leaves the session
 * over budget and the next turn fails too, which is a loop, not a degradation.
 * The budget below is therefore a small fraction of the advertised window.
 */

/**
 * The budget arithmetic moved to `budget.js` in D-7, because it stopped being a
 * constant and became a measurement: the model's context window is read from
 * the daemon, and the fixed cost of the system prompt and tool schemas is
 * measured per turn. What is left here is what compaction itself decides.
 */
export { estimateTextTokens };

/**
 * A fallback for callers that have not measured — the offline suite, and any
 * path that wants a number without probing a daemon. Live turns pass a real
 * budget computed by `computeBudget()`.
 */
export const DEFAULT_HISTORY_BUDGET = 13_000;

/**
 * The minimum a compaction must SAVE to be worth doing.
 *
 * Without this, compaction fires the moment history crosses the budget by one
 * token, folds a handful of small turns into a digest that costs nearly as
 * much as they did, and lands just under the line — where the next tool result
 * pushes it straight back over. That is the thrash that produced three digests
 * in a single turn. A compaction that saves less than this is not a saving, it
 * is an LLM call and a loss of verbatim history in exchange for nothing.
 */
export const MIN_COMPACTION_GAIN = 1_500;

/**
 * What a digest costs, for projecting the gain BEFORE paying for one.
 *
 * The real size is unknowable until the summariser has run, which is the call
 * this threshold exists to avoid making. Measured across live digests the
 * four-section format lands around 600-900 tokens; the high end is used, so the
 * projection under-promises and the threshold errs toward not compacting.
 */
const TYPICAL_DIGEST_TOKENS = 900;

/**
 * The most transcript the summariser is given in one go.
 *
 * When a span is bigger than this the span SHRINKS — fewer of the oldest
 * entries are folded — rather than the transcript being truncated. Truncating
 * would silently drop whatever fell off the end, and what falls off the end of
 * a transcript is the most recent, most relevant identifiers. Folding less is
 * a smaller win; folding a truncated span is a wrong one.
 *
 * The number is a dilution bound, not a reliability one. The upstream took
 * 51,429 real prompt tokens without a single failure across 35 shots (see
 * budget.js), so the summariser is in no danger of being too big to send. What
 * it IS in danger of is being handed so much transcript that the identifiers
 * that matter get crowded out — measured once, when a digest enumerated 100+
 * record numbers and lost the one flow sys_id that was being asked about. In
 * estimated tokens, 24,000 is roughly 17,000 real: a large span, still bounded.
 */
const MAX_SUMMARIZER_INPUT_TOKENS = 24_000;

/** Turns always kept verbatim, however long they are. */
export const KEEP_LAST_TURNS = 8;

/** Never compact below this — with too little history a digest costs more than it saves. */
const MIN_TURNS_TO_COMPACT = 6;

/** Rough token estimate over the NEUTRAL history, before any provider translation. */
export function estimateTokens(history) {
  let chars = 0;
  for (const m of history || []) {
    if (!m) continue;
    if (m.text) chars += m.text.length;
    for (const tc of m.toolCalls || []) {
      chars += (tc.name?.length || 0) + JSON.stringify(tc.input ?? {}).length;
    }
    for (const r of m.results || []) {
      chars += (r.name?.length || 0) + (r.output?.length || 0);
    }
    chars += 8; // per-message envelope
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const DIGEST_SYSTEM = `You compress the opening of a ServiceNow engineering conversation into a structured digest. It replaces those turns verbatim, so anything you leave out is GONE — the agent will not be able to answer a question about it later.

Respond with ONLY this shape, no prose outside it, no markdown fences:

ARTIFACTS BUILT OR CHANGED
- <name> — <type> — sys_id <the sys_id> — <state: active / deleted / failed>
(ONLY records this conversation CREATED, UPDATED or DELETED. These identifiers cannot be reconstructed and are what gets asked for later, so this section matters more than the rest combined. If none, write "none".)

RECORDS ONLY LOOKED AT
- <one line: how many, from which table, and what the query was for>
(Query RESULTS are transient. Summarise them as a COUNT — never list them. Twenty incident numbers from a search are noise; that a search for unassigned criticals returned twenty is the fact worth keeping.)

DECISIONS
- <what was decided, and why, in one line>
(choices the user made or approved, and constraints they set. If none, write "none".)

OPEN THREADS
- <what was still unfinished, and what the next step was>
(anything asked for and not yet delivered, anything that failed and was not retried. If none, write "none".)

RULES:
1. Copy every sys_id, record number and exact artifact name in the FIRST section CHARACTER FOR CHARACTER. A mistyped sys_id is worse than an omitted one — it will be used.
2. Never summarise an identifier as "the incident" or "the flow created earlier". Name it.
3. Do NOT enumerate records that were merely read. If a tool returned a list, give the count and the intent, nothing more. Listing them crowds out the identifiers that matter and is the one way this digest can fail while looking complete.
4. Record what FAILED as carefully as what succeeded, including the reason.
5. Do not add anything that is not in the transcript. If a section is empty, write "none".
6. Emit all four headings, in this order, always.`;

/** All four headings must be present, or the digest was cut off mid-generation. */
const REQUIRED_HEADINGS = ['ARTIFACTS BUILT OR CHANGED', 'RECORDS ONLY LOOKED AT', 'DECISIONS', 'OPEN THREADS'];

/**
 * The transcript text handed to the summariser.
 *
 * List-shaped tool results are collapsed to a count and one sample row. A live
 * run against gpt-oss showed why this belongs here rather than in the prompt:
 * handed 60 query results of 12 records each, the model dutifully copied 100+
 * record numbers, hit its token cap, and dropped the one flow sys_id that
 * actually mattered. Asking it not to is weaker than not showing it.
 */
function summariseOutput(output) {
  const text = String(output || '');
  if (text.length < 400) return text;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const sample = parsed.length ? JSON.stringify(parsed[0]).slice(0, 220) : '';
      return `[${parsed.length} rows returned; first row: ${sample}]`;
    }
  } catch { /* not JSON — fall through to a plain trim */ }
  return `${text.slice(0, 1200)}…[trimmed]`;
}

function renderSpan(entries) {
  const parts = [];
  for (const m of entries) {
    if (m.role === 'user') parts.push(`USER: ${m.text}`);
    else if (m.role === 'assistant') {
      if (m.text) parts.push(`ASSISTANT: ${m.text}`);
      for (const tc of m.toolCalls || []) {
        parts.push(`ASSISTANT CALLED ${tc.name}(${JSON.stringify(tc.input ?? {}).slice(0, 600)})`);
      }
    } else if (m.role === 'tool') {
      for (const r of m.results || []) {
        parts.push(`RESULT ${r.name}${r.isError ? ' [ERROR]' : ''}: ${summariseOutput(r.output)}`);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Compact if over budget. Returns {compacted:false} when nothing was needed —
 * the common case, and it must stay cheap since this runs every iteration.
 */
export async function compactIfNeeded(
  sessionId,
  {
    budget = DEFAULT_HISTORY_BUDGET,
    keepLast = KEEP_LAST_TURNS,
    // Injectable so the offline suite can exercise the real splice, budget
    // arithmetic and failure paths without an LLM. The default is the live one.
    summarize = null,
  } = {}
) {
  const history = loadHistory(sessionId);
  const before = estimateTokens(history);
  if (before <= budget) return { compacted: false, tokens: before, budget };
  if (history.length < MIN_TURNS_TO_COMPACT + keepLast) {
    // Over budget but too short to fold: the recent turns themselves are huge.
    // Say so rather than silently doing nothing — the next call may well fail.
    return {
      compacted: false,
      tokens: before,
      budget,
      warning:
        `This session is over the ${budget}-token history budget (~${before}) but has only ${history.length} ` +
        `entries, so there is nothing old enough to fold away. The recent turns are individually large — ` +
        `usually one very large tool result.`,
    };
  }

  const db = getDb();
  const rows = db.prepare('SELECT seq FROM messages WHERE session = ? ORDER BY seq ASC').all(sessionId);
  let cutIndex = Math.max(0, rows.length - keepLast);

  /*
   * F2 — THE CUT IS ROLE-AWARE, because a row count is not a turn boundary.
   *
   * MEASURED, from the session that produced this fix. A long tool loop ran
   * thirteen assistant/tool rows past its opening user message, compaction
   * fired mid-turn on iteration seven, and `rows.length - 8` landed AFTER that
   * message. The fold deleted it. What went to the model was
   * `[system, assistant(tool_calls), tool, ...]` with no user turn anywhere in
   * it, and Ollama answered 200 with `finish_reason: "load"` and no content —
   * six times, because the retry and the UI's Retry both re-send the same
   * history.
   *
   * So the cut never crosses the newest user row. That row is the only thing
   * in the request that says what is being asked, and `keepLast` cannot know
   * it: eight rows is four tool round-trips, and a real turn routinely runs
   * longer than that. Clamping here rather than compacting only at iteration 0
   * is deliberate — budget pressure PEAKS during a long tool loop, which is
   * exactly when mid-turn compaction has to keep working.
   *
   * The clamp only ever moves the cut EARLIER, so it cannot split a pair the
   * row-count cut would have kept whole, and it lands the fold on a user turn —
   * a real boundary rather than an arithmetic one.
   */
  const newestUserIndex = history.reduce((acc, m, i) => (m?.role === 'user' ? i : acc), -1);
  const clampedToUserTurn = newestUserIndex >= 0 && newestUserIndex < cutIndex;
  if (clampedToUserTurn) cutIndex = newestUserIndex;

  if (!cutIndex) {
    // Nothing foldable. When the clamp is what made it so, say that: "the
    // session is over budget and compaction did nothing" is the shape of a
    // silent failure, and this one has a nameable reason.
    return clampedToUserTurn
      ? {
        compacted: false,
        tokens: before,
        budget,
        skipped: 'user-turn-clamp',
        warning:
          `Skipped compaction: everything older than the active turn's user message has already been folded, ` +
          `so there is nothing left to compact without deleting that message. The session is over budget ` +
          `(~${before} vs ${budget}) and will stay there for this turn.`,
      }
      : { compacted: false, tokens: before, budget };
  }

  /*
   * DIGESTS ARE ANCHORED, and it costs nothing to keep them that way.
   *
   * `replaceSpanWithDigest` DELETES the folded messages and writes the digest
   * to a separate `digests` table, which `loadHistory` never reads — the digest
   * reaches the model through the system prompt instead. So everything below is
   * by construction the span AFTER the newest digest, and a digest can never be
   * fed back to the summariser to be compressed a second time. The property is
   * structural rather than defended, which is the good kind; it is stated here
   * because "re-summarising the summary" is the first thing a reader worries
   * about, and the answer is in a different file.
   */

  // Shrink the span until the summariser's input fits, rather than truncating
  // the transcript. See MAX_SUMMARIZER_INPUT_TOKENS.
  let entries = history.slice(0, cutIndex);
  let transcript = renderSpan(entries);
  while (cutIndex > MIN_TURNS_TO_COMPACT && estimateTextTokens(transcript) > MAX_SUMMARIZER_INPUT_TOKENS) {
    cutIndex -= 1;
    entries = history.slice(0, cutIndex);
    transcript = renderSpan(entries);
  }

  /*
   * Is this worth doing at all? A compaction that saves less than it costs is
   * the thrash loop, and the only way to not pay for it is to not make the call.
   */
  const spanTokens = estimateTokens(entries);
  const projectedGain = spanTokens - TYPICAL_DIGEST_TOKENS;
  if (projectedGain < MIN_COMPACTION_GAIN) {
    return {
      compacted: false,
      tokens: before,
      budget,
      skipped: 'min-gain',
      warning:
        `Skipped compaction: folding the oldest ${entries.length} entries would save about ${Math.max(0, projectedGain)} ` +
        `tokens, under the ${MIN_COMPACTION_GAIN}-token floor. The session is over budget (~${before} vs ${budget}) ` +
        `because the RECENT turns are large, and compacting would cost an LLM call and the verbatim history to ` +
        `land just under the line until the next tool result pushes it back over.`,
    };
  }

  const span = rows.slice(0, cutIndex);
  const fromSeq = span[0].seq;
  const toSeq = span[span.length - 1].seq;

  let digest;
  try {
    digest = summarize
      ? await summarize(transcript, entries)
      : await chatOnce({
          system: DIGEST_SYSTEM,
          user: `TRANSCRIPT TO COMPRESS (${entries.length} entries):\n\n${transcript}`,
          // Generous on purpose: this model spends hidden reasoning tokens from
          // the same budget, and a truncated digest silently loses identifiers.
          maxTokens: 6000,
          decoding: codegenDecoding(`compact:${sessionId}:${fromSeq}`, 1),
        });
  } catch (err) {
    // Loud, and non-destructive: the span is NOT deleted, so nothing is lost.
    // The session stays over budget and the caller can see why.
    log.warn('memory', `compaction failed for session ${sessionId} — history kept intact`, err.message);
    return {
      compacted: false,
      tokens: before,
      budget,
      error: `Compaction failed, so no history was discarded: ${err.message}`,
    };
  }

  const text = String(digest || '').trim();
  if (text.length < 40) {
    // The summariser is the same model, on the same flaky upstream, and it can
    // return nothing for exactly the reasons the main call can. The rule is the
    // same as everywhere else in D-7: an empty completion is an error path, not
    // a result. Keeping the raw span is the deterministic fallback — the
    // session stays over budget, which is a degradation, where splicing an
    // empty digest would be a silent loss of every identifier in the span.
    log.warn('memory', `compaction summariser returned an empty digest for session ${sessionId} — raw span kept, skipping`);
    return { compacted: false, tokens: before, budget, error: 'Compaction produced an empty digest; no history was discarded.' };
  }

  // A digest that ran out of tokens mid-generation looks perfectly fine — it is
  // well-formed text that simply stops, and the part it dropped is the tail.
  // Measured live: one run enumerated 100+ query-result record numbers, hit the
  // cap, and lost the flow sys_id entirely, while reporting success. Requiring
  // every heading turns that silent loss into a refusal.
  const missing = REQUIRED_HEADINGS.filter((h) => !text.includes(h));
  if (missing.length) {
    log.warn('memory', `compaction produced an incomplete digest for session ${sessionId} (missing ${missing.join(', ')}) — raw span kept`);
    return {
      compacted: false,
      tokens: before,
      budget,
      error:
        `Compaction produced an incomplete digest — missing ${missing.join(', ')} — which means it was cut off ` +
        `before the end and would have silently dropped whatever came after. No history was discarded.`,
    };
  }

  replaceSpanWithDigest(sessionId, fromSeq, toSeq, text);
  const after = estimateTokens(loadHistory(sessionId));
  log.info('memory', `compacted ${entries.length} entries for session ${sessionId}: ${before} -> ${after} tokens (budget ${budget})`);
  return { compacted: true, fromSeq, toSeq, entries: entries.length, tokensBefore: before, tokensAfter: after, budget };
}

/**
 * The digests, rendered for the system prompt. This is the "spliced as a
 * system-side note" half: the compressed past arrives as established context
 * rather than as a forged conversational turn nobody actually said.
 */
export function buildDigestNote(sessionId) {
  const digests = loadDigests(sessionId);
  if (!digests.length) return '';
  return (
    `EARLIER IN THIS SESSION — a compressed record of turns that are no longer quoted verbatim.\n` +
    `Treat the identifiers here as established fact; they were read off the instance during this session.\n\n` +
    digests.map((d) => d.text).join('\n\n---\n\n')
  );
}
