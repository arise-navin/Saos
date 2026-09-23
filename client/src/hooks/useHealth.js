import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * D-3 — one source of truth for "is an instance bound and reachable".
 *
 * Before this, four different things answered that question and disagreed:
 * the topbar polled `/api/system/health`, the Dashboard read
 * `/api/system/settings`, and Incidents, SLA and Flows each inferred it from
 * an empty result list — which is how "no incidents match" and "you are not
 * connected" ended up rendered as the same sentence. That is the same class
 * of quiet wrongness the ACL analyzer had to grow a `visibility` field for:
 * an empty table and an unreadable one look identical unless something says
 * which it is.
 *
 * The store is module-level with one shared poller, so eight subscribers do
 * not mean eight requests every twenty seconds, and a page mounting mid-cycle
 * gets the last known answer immediately instead of flashing "disconnected".
 */

const POLL_MS = 20_000;

let state = { loading: true, health: null, error: null };
const listeners = new Set();
let timer = null;
let inFlight = null;

function emit() {
  const snapshot = state;
  for (const fn of listeners) fn(snapshot);
}

async function poll() {
  if (inFlight) return inFlight;
  inFlight = api
    .get('/system/health')
    .then((health) => { state = { loading: false, health, error: null }; })
    .catch((err) => {
      // The SERVER is unreachable, which is a different failure from an
      // unbound instance, and the banner says so rather than blaming the PDI.
      state = { loading: false, health: null, error: err.message };
    })
    .finally(() => { inFlight = null; emit(); });
  return inFlight;
}

/** Called after anything that changes the binding, so the UI never lags a save. */
export function refreshHealth() {
  return poll();
}

function subscribe(fn) {
  listeners.add(fn);
  if (listeners.size === 1) {
    poll();
    timer = setInterval(poll, POLL_MS);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

export function useHealth() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => subscribe(setSnapshot), []);
  return {
    ...snapshot,
    /**
     * `connected` means credentials are stored, not that a request will
     * succeed — /system/health deliberately does not round-trip the instance
     * on a 20s timer. Anything stronger is what "Test connection" is for.
     */
    connected: Boolean(snapshot.health?.connected),
    instanceUrl: snapshot.health?.instanceUrl || null,
    serverDown: Boolean(snapshot.error),
  };
}
