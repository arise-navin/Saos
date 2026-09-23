import { table } from '../servicenow/client.js';
import { log } from '../logging.js';

/**
 * WI-7 — turning two recurring dead ends into something the user can decide.
 *
 * **The business-rule abort.** A write to `incident` carrying assignment fields
 * was aborted by a rule called "Abort changes on group". The agent adapted by
 * silently dropping those fields from every later write — permanently degrading
 * what it could do, without telling anyone, and without ever looking at the
 * rule.
 *
 * Looking at it changes the answer completely. Read off dev442675, the rule is
 * `assigned_toISNOTEMPTY^assignment_groupVALCHANGES^assignment_groupISNOTEMPTY`
 * and it aborts only when the assigned user is NOT a member of the assignment
 * group. That is correct business logic, not an obstacle — so "drop the fields
 * forever" was the worst of the available options, and "pick a user who is in
 * the group" was never offered.
 *
 * It also has to be LOOKED UP rather than described. The transcript reported
 * the rule's sys_id as `bfdd88168376c750b939cc65eeaad39f`, which exists on no
 * table on that instance — a fabricated identifier presented as a finding. The
 * enrichment below returns real rows or says it found none.
 *
 * **Data vs configuration.** The pipeline already computes "incident does not
 * extend sys_metadata", and the prose never surfaced it, so the user came away
 * believing an incident had been created inside an update set. It cannot be:
 * update sets carry configuration, and an incident is data.
 */

/** The rule name the instance names in an abort. Empty when it is not one. */
export function parseBusinessRuleAbort(detail) {
  const m = /aborted by Business Rule '([^'^]+)/i.exec(String(detail || ''));
  return m ? m[1] : null;
}

/**
 * Find the actual rule(s) behind an abort.
 *
 * Matched on name AND table, because "Abort changes on group" exists five times
 * on this instance — one per task table — and reporting the `change_task` copy
 * for an `incident` write would be a confident wrong answer.
 */
export async function locateBusinessRules(name, tableName) {
  if (!name) return [];
  const clauses = [`name=${name}`];
  if (tableName) clauses.push(`collection=${tableName}`);
  try {
    const rows = await table.query('sys_script', {
      query: clauses.join('^'),
      fields: 'sys_id,name,collection,when,active,order,condition,filter_condition,sys_scope,description',
      limit: 10, display: 'false',
    });
    return rows.map((r) => ({
      sys_id: r.sys_id, name: r.name, table: r.collection, when: r.when,
      active: r.active === 'true', order: r.order,
      condition: r.condition || null, filter: r.filter_condition || null,
      scope: r.sys_scope, description: r.description || null,
    }));
  } catch (err) {
    log.warn('playbook', `could not look up business rule "${name}": ${err.message}`);
    return [];
  }
}

/**
 * The options a user should be offered when a rule aborts a write.
 *
 * Ordered by how little damage they do. Silently adapting the payload forever
 * is last and is named as a permanent degradation, because that is what it is
 * and it was what happened by default.
 */
export async function businessRuleAbortPlaybook({ detail, table: tableName }) {
  const ruleName = parseBusinessRuleAbort(detail);
  if (!ruleName) return null;
  const rules = await locateBusinessRules(ruleName, tableName);

  return {
    abortedBy: ruleName,
    rules: rules.length ? rules : null,
    lookedUp: true,
    ...(rules.length ? {} : {
      note: `No business rule named "${ruleName}" was found on ${tableName || 'this table'}. `
          + 'Report that it could not be located rather than describing one — and never state a sys_id you did not read back.',
    }),
    // Written for the model to relay, because "what do you want to do" is the
    // user's decision and it was never put to them.
    offerToUser: [
      'Satisfy the rule — read its condition above and change the payload so it passes. This is usually the right answer: '
        + 'the rule generally encodes a real policy, not an obstacle.',
      'Scope it — narrow the rule\'s condition or filter so it does not apply to this case.',
      'Disable it — set active=false on the rule. This is a configuration change to the instance and needs its own approval.',
      'Adapt the payload for now — drop or change the offending fields, stating clearly that the write will be incomplete.',
    ],
    instruction:
      'Do NOT silently drop the blocked fields from later writes. Show the user the rule and these options and let them choose. '
      + 'Quietly degrading every future write is the one option that hides the problem.',
  };
}

/* ------------------------------------------------------------------ *
 * Data vs configuration
 * ------------------------------------------------------------------ */

/**
 * The sentence the agent has to say out loud when a user asks for a data record
 * to be "in" an update set or an application scope.
 *
 * Returned as part of the tool result rather than left to the prompt, because
 * the pipeline already knows the answer and the prompt demonstrably did not
 * produce it.
 */
export function dataVsConfigNote(captureEvent, tableName) {
  if (!captureEvent || captureEvent.reason !== 'data') return null;
  const t = captureEvent.table || tableName || 'this table';
  return {
    captured: false,
    reason: 'data',
    explain:
      `${t} is DATA, not configuration. Update sets capture only descendants of sys_metadata — catalog items, `
      + 'business rules, flows, UI policies, SLA definitions. Records like incidents, requests and tasks are never '
      + 'captured by an update set and do not belong to an application scope.',
    sayToUser:
      `Tell the user this in one sentence: the record was created, but it is data, so it is not in the update set and `
      + 'cannot be — update sets carry configuration only.',
  };
}
