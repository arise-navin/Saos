/**
 * D-7 — the degenerate-request guard.
 *
 * MEASURED, and the measurement is the whole reason this file exists. A long
 * spec produced, in ONE turn, three compaction digests, several blank assistant
 * rows, and then `ollama returned an empty completion (finish reason: load)`.
 * The model is gpt-oss:120b-cloud with a 131,072-token context — read off the
 * daemon, not assumed:
 *
 *   $ curl -s localhost:11434/api/show -d '{"model":"gpt-oss:120b-cloud"}'
 *     "gptoss.context_length": 131072
 *
 * so this was never context overflow. The blank rows were the tell.
 *
 * §29's fix rejected an assistant turn with `!res.text && !res.toolCalls`.
 * That guard is truthiness, and "\n" is truthy. A whitespace-only completion —
 * which this model emits when it spends its budget on reasoning and flushes a
 * bare newline — passed every check, rendered as an empty bubble, and was
 * appended to history as a real turn. From then on every outbound request
 * carried `{role:'assistant', content:'\n'}`.
 *
 * So the rule is structural, not stylistic: a message must carry non-whitespace
 * content or tool_calls, or it is not a message and must never reach the wire.
 * Enforced in three places, deliberately:
 *
 *   1. the orchestrator, so a blank completion is an ERROR PATH, never a row;
 *   2. this sanitizer, run over the history before every send, which also
 *      repairs sessions that already have blank rows persisted in SQLite;
 *   3. the adapter's outbound validation, which is the backstop — by the time
 *      a request is being serialised, a degenerate message must be impossible
 *      rather than merely unlikely.
 *
 * Dropping is not free and is never silent: every removal is counted and
 * reported to the caller, which logs it at warn.
 */

/** Non-whitespace content is the test. `''`, `'\n'` and `'   '` are all blank. */
export function isBlankText(text) {
  return String(text ?? '').trim().length === 0;
}

/**
 * An assistant turn that said nothing and did nothing.
 *
 * An assistant turn with tool_calls and empty content is NOT blank — that shape
 * is legal and measured to return 200, and it is what every tool-calling turn
 * looks like. Only the both-empty case is degenerate.
 */
export function isBlankTurn(entry) {
  if (!entry || entry.role !== 'assistant') return false;
  return isBlankText(entry.text) && !(entry.toolCalls?.length > 0);
}

/**
 * Drop what cannot legally be sent, and report what was dropped.
 *
 * Returns `{ history, dropped, reasons, hasUserTurn }`. `dropped` is 0 for a healthy
 * session, which is the common case and must stay cheap — this runs on every
 * iteration of every turn.
 *
 * Two shapes are removed:
 *   - blank assistant turns (above);
 *   - tool results with no matching tool_call earlier in the history, which
 *     the wire format rejects outright. These cannot arise from a healthy run,
 *     but they can arise from a compaction that folded away the assistant turn
 *     while leaving its results behind, and from any session written before
 *     this guard existed.
 */
export function sanitizeHistory(history) {
  const reasons = [];
  const seenCallIds = new Set();
  const out = [];

  for (const entry of history || []) {
    if (!entry || !entry.role) {
      reasons.push('a malformed history row with no role');
      continue;
    }
    if (isBlankTurn(entry)) {
      reasons.push('a blank assistant turn (no text, no tool calls)');
      continue;
    }
    if (entry.role === 'assistant') {
      for (const tc of entry.toolCalls || []) if (tc?.id) seenCallIds.add(tc.id);
      out.push(entry);
      continue;
    }
    if (entry.role === 'tool') {
      const kept = (entry.results || []).filter((r) => r?.id && seenCallIds.has(r.id));
      const lost = (entry.results || []).length - kept.length;
      if (lost > 0) reasons.push(`${lost} orphaned tool result(s) with no matching tool call`);
      // A tool message with nothing left in it is itself unsendable.
      if (!kept.length) continue;
      out.push(kept.length === (entry.results || []).length ? entry : { ...entry, results: kept });
      continue;
    }
    // A user turn with no text is the one blank we keep quiet about: the
    // orchestrator's own guard notes are written as user turns and are never
    // empty, and a genuinely empty user turn cannot be produced by the UI.
    if (entry.role === 'user' && isBlankText(entry.text)) {
      reasons.push('a blank user turn');
      continue;
    }
    out.push(entry);
  }

  return {
    history: out,
    dropped: (history || []).length - out.length,
    reasons,
    // F3 — the one PRESENCE fact in a report otherwise made of absences.
    // A history with no user turn is not repairable here (inventing one would
    // be inventing what was asked), so this is reported rather than fixed; the
    // adapter refuses the send. It is on the report because by the time the
    // request is refused, the useful question is which layer lost the row.
    hasUserTurn: out.some((m) => m.role === 'user'),
  };
}
