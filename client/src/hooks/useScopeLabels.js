import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Resolve scope sys_ids to scope NAMES, in one request for a whole list.
 *
 * Artifact rows carry `sys_scope` as a sys_id. Its `display_value` is the
 * application's friendly name ("Service Level Management - ATF"), which is not
 * what a scope badge should say: the scope name is the ADDRESS — the thing that
 * prefixes an artifact, that `now.config.json` claims, and that decides which
 * update set a change can move into.
 *
 * Batched deliberately. Resolving per row is one request per row, and the SLA
 * and Access pages routinely render fifty. The server answers the whole set in
 * a single read and maps unknown ids to themselves, so a badge never silently
 * empties.
 *
 * A failure is not fatal: the map stays empty and callers fall back to the id,
 * which renders truncated. A page must not fail to load because a cosmetic
 * label could not be resolved.
 */
export function useScopeLabels(ids) {
  const [labels, setLabels] = useState({});
  // Sorted + joined so the effect is keyed on the SET of ids, not on the array
  // identity a re-render produces.
  const key = [...new Set((ids || []).filter(Boolean).map(String))].sort().join(',');

  useEffect(() => {
    if (!key) { setLabels({}); return undefined; }
    let live = true;
    api.post('/applications/scope-labels', { ids: key.split(',') })
      .then((r) => { if (live) setLabels(r.labels || {}); })
      .catch(() => { /* the id itself is a usable fallback */ });
    return () => { live = false; };
  }, [key]);

  return labels;
}
