/**
 * WI-1 — post-mutation write verification.
 *
 * THE DEFECT THIS EXISTS FOR. `update_record` on `sys_update_set`
 * 29b5648983be0f10b939cc65eeaad36b with `{application: "73cd8416…"}` returns
 * HTTP 2xx and a record whose `application.value` is still `global`,
 * `sys_mod_count` still `0`, and `sys_updated_on` still the creation timestamp.
 * A total no-op, reported as success. The same write was approved THREE times.
 * Re-measured on dev442675 during this sprint — the record and the behaviour
 * are both still there.
 *
 * A 2xx from the Table API means "the request was accepted", not "the fields
 * you sent were stored". Nothing else in this codebase was checking the
 * difference, so the agent could only report what the HTTP layer told it.
 *
 * This module is PURE — no I/O, no instance, no schema fetch. The pipeline
 * hands it what it already has. That is what makes every rule below testable
 * offline against recorded fixtures, which matters because the rules encode
 * platform behaviour that is expensive and slow to reproduce live.
 *
 * Everything here was measured rather than assumed (see §36):
 *
 *   journal fields    `comments` writes fine and reads back `value: ""` — the
 *                     text is only in `display_value`, with a timestamp and an
 *                     author wrapped around it. Never verifiable by echo.
 *   booleans          `active: true` (a real boolean) returns `"true"`.
 *   choice labels     `state: "On Hold"` is RESOLVED to `"3"`, and the returned
 *                     `display_value` comes back as "On Hold" — which is the
 *                     discriminator: a returned display equal to what was asked
 *                     for proves a label was resolved, not that a write was lost.
 *   computed fields   `priority` is derived from impact+urgency; writing it is
 *                     ignored (trap #5).
 *   unknown fields    a field that is not a column is ABSENT from the response
 *                     entirely, rather than returned empty (traps #3, #4).
 */

/** Field types whose stored value never echoes back in the record body. */
const NEVER_ECHOES = new Set(['journal', 'journal_input', 'journal_list']);

/**
 * Fields the platform computes, per table family. Writing them is accepted and
 * ignored, so a difference here is expected behaviour and not a lost write.
 * Keyed on the table's own name or any ancestor, so `incident` inherits `task`.
 */
const PLATFORM_COMPUTED = {
  task: ['priority'],
};

/** Server-maintained; never diffed, and never in a request payload anyway. */
const SERVER_CONTROLLED = new Set([
  'sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by',
  'sys_mod_count', 'sys_class_name', 'sys_tags', 'number',
]);

const cell = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const display = (v) => (v && typeof v === 'object' && 'display_value' in v ? v.display_value : undefined);

/**
 * One comparable string per value.
 *
 * Booleans become the strings the platform returns; numbers become their
 * decimal form so `"3"` and `3` agree; null, undefined and `""` all collapse to
 * `""` so "absent in the request" and "empty on the record" are the same fact.
 */
export function normalizeValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v).trim();
}

/** Which requested fields are computed for this table (walking its ancestors). */
function computedFor(tableName, chain = []) {
  const names = [tableName, ...chain];
  const out = new Set();
  for (const n of names) for (const f of PLATFORM_COMPUTED[n] || []) out.add(f);
  return out;
}

/**
 * Cheap, decisive, and checked BEFORE the field diff: an update whose
 * `sys_mod_count` and `sys_updated_on` are unchanged did nothing at all.
 *
 * Needs the pre-write record. Without one it answers `null` — "not checked" —
 * rather than `false`, because "we did not look" and "we looked and it moved"
 * must not render the same way.
 */
export function detectNoOpSignal(before, returned) {
  if (!before || !returned) return null;
  const b = { mod: normalizeValue(cell(before.sys_mod_count)), at: normalizeValue(cell(before.sys_updated_on)) };
  const a = { mod: normalizeValue(cell(returned.sys_mod_count)), at: normalizeValue(cell(returned.sys_updated_on)) };
  if (!b.mod && !b.at) return null;
  return {
    unchanged: b.mod === a.mod && b.at === a.at,
    sys_mod_count: { before: b.mod, after: a.mod },
    sys_updated_on: { before: b.at, after: a.at },
  };
}

/**
 * Diff what was asked for against what came back.
 *
 * `before` is optional and only available for updates; supplying it makes
 * `dropped` provable rather than inferred, because "the value the record
 * already had" is exactly what a silently discarded write leaves behind.
 */
export function diffWrite({
  table: tableName = '',
  operation = 'update',          // 'insert' | 'update'
  requested = {},
  returned = {},
  before = null,
  fieldTypes = {},               // field -> internal_type, when the caller has the schema
  hierarchy = [],
} = {}) {
  const applied = [];
  const dropped = [];
  const transformed = [];
  const unverifiable = [];

  const computed = computedFor(tableName, hierarchy);
  const noOpSignal = operation === 'update' ? detectNoOpSignal(before, returned) : null;

  for (const [field, wantRaw] of Object.entries(requested || {})) {
    if (SERVER_CONTROLLED.has(field)) continue;   // never sent, never diffed

    const want = normalizeValue(wantRaw);
    const type = fieldTypes[field];

    // 1. Journal fields store fine and read back empty. Saying "dropped" here
    //    would be a confident wrong answer about a write that worked.
    if (NEVER_ECHOES.has(type)) {
      unverifiable.push({ field, requested: want, reason: `${type} fields never echo back in the record body` });
      continue;
    }

    // 2. A requested field absent from the response is not a column on this
    //    table. The platform accepts it and discards it without complaint.
    if (!(field in (returned || {}))) {
      dropped.push({ field, requested: want, actual: null, reason: 'not returned at all — the field is not a column on this table' });
      continue;
    }

    const got = normalizeValue(cell(returned[field]));
    const shown = display(returned[field]);

    if (got === want) { applied.push({ field, value: got }); continue; }

    // 3. A label the platform resolved to its stored value. The proof is the
    //    returned DISPLAY equalling what was asked for — the write landed, it
    //    was just addressed by label instead of by value.
    if (shown !== undefined && normalizeValue(shown).toLowerCase() === want.toLowerCase() && want !== '') {
      transformed.push({ field, requested: want, actual: got, reason: 'a choice label was resolved to its stored value' });
      continue;
    }

    // 4. Computed by the platform from other fields. Surfaced, never an error.
    if (computed.has(field)) {
      transformed.push({ field, requested: want, actual: got, reason: 'platform-computed from other fields' });
      continue;
    }

    // 5. The returned value is what the record already had — the write was
    //    discarded and the old value left in place. This is the E1 signature.
    if (before && field in before && normalizeValue(cell(before[field])) === got) {
      dropped.push({ field, requested: want, actual: got, reason: 'unchanged — the record still holds its previous value' });
      continue;
    }

    // 6. On an INSERT there is no previous value to compare against, so a
    //    returned value that is neither what was asked for nor an explainable
    //    transform is the platform substituting its own. That is E2:
    //    sys_update_set.application forced to `global` on create.
    if (operation === 'insert') {
      dropped.push({ field, requested: want, actual: got, reason: 'the platform stored a different value than the one requested' });
      continue;
    }

    transformed.push({ field, requested: want, actual: got, reason: 'stored a different value than the one requested' });
  }

  const verifiableCount = applied.length + dropped.length + transformed.length;
  let status;
  if (verifiableCount === 0) status = 'unverified';
  else if (dropped.length && applied.length === 0 && transformed.length === 0) status = 'no-op';
  else if (dropped.length) status = 'partial';
  else if (transformed.length) status = 'transformed';
  else status = 'applied';

  // The corroborating signal can promote a "partial" to a "no-op": if nothing
  // on the record moved, nothing was stored, whatever the field diff inferred.
  if (noOpSignal?.unchanged && dropped.length) status = 'no-op';

  return {
    verified: status === 'applied',
    status,
    summary: summarize(status, { applied, dropped, transformed, unverifiable }),
    applied,
    dropped,
    transformed,
    unverifiable,
    noOpSignal,
  };
}

function summarize(status, { applied, dropped, transformed, unverifiable }) {
  switch (status) {
    case 'applied':
      return `all ${applied.length} requested field${applied.length === 1 ? '' : 's'} stored as sent`;
    case 'no-op':
      return `no-op: the platform discarded this write — ${dropped.map((d) => d.field).join(', ')} unchanged`;
    case 'partial':
      return `partial: the platform dropped ${dropped.length} field${dropped.length === 1 ? '' : 's'} (${dropped.map((d) => d.field).join(', ')})`;
    case 'transformed':
      return `stored, but ${transformed.length} field${transformed.length === 1 ? '' : 's'} differ from what was sent (${transformed.map((t) => t.field).join(', ')})`;
    default:
      return unverifiable.length
        ? `not verifiable by echo: ${unverifiable.map((u) => u.field).join(', ')}`
        : 'nothing to verify';
  }
}

/**
 * The block that goes into the tool result the MODEL reads.
 *
 * Trimmed on purpose: the model needs the verdict and the offending fields, not
 * the applied list, which on a large payload is most of the payload again. The
 * full object stays available to the ledger and the renderer.
 */
export function verificationForModel(v) {
  if (!v) return null;
  const out = { verified: v.verified, status: v.status, summary: v.summary };
  if (v.dropped.length) out.dropped = v.dropped.map(({ field, requested, actual, reason }) => ({ field, requested, actual, reason }));
  if (v.transformed.length) out.transformed = v.transformed.map(({ field, requested, actual, reason }) => ({ field, requested, actual, reason }));
  if (v.unverifiable.length) out.unverifiable = v.unverifiable.map(({ field, reason }) => ({ field, reason }));
  if (v.noOpSignal?.unchanged) {
    out.noOpSignal = 'sys_mod_count and sys_updated_on are unchanged — nothing on this record moved';
  }
  return out;
}

export const _internals = { NEVER_ECHOES, PLATFORM_COMPUTED, SERVER_CONTROLLED };
