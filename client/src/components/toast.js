/**
 * D-2 — transient feedback, in one place.
 *
 * The seam is a module-level store rather than a React context on purpose.
 * Toasts get raised from event handlers, from `.catch()` blocks, and from SSE
 * callbacks that outlive the render that started them; threading a context
 * through all of those would have meant touching every call site to add a
 * hook, which is exactly the churn `confirm.js` was written to avoid.
 *
 * It is also why this is a store and not a "register a sink" callback: React
 * runs effects child-first, so a page that toasts from its own mount effect
 * would fire BEFORE the host at the app root had registered. Queuing in a
 * plain array means an early toast is rendered late, never dropped.
 *
 * Inline notices are NOT replaced wholesale. The rule applied across the app:
 * transient outcomes ("saved", "reordered", "deleted") become toasts; anything
 * a person needs to read while fixing a form — validation, a diagnostic, a
 * capability banner — stays inline where the problem is.
 */

let seq = 0;
let items = [];
const listeners = new Set();

/** Errors carry information worth reading twice; successes do not. */
const DEFAULT_MS = { success: 4000, info: 5000, error: 9000 };

function emit() {
  for (const fn of listeners) fn(items);
}

export function subscribeToasts(fn) {
  listeners.add(fn);
  fn(items);
  return () => { listeners.delete(fn); };
}

export function dismissToast(id) {
  const next = items.filter((t) => t.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

function push(level, message, opts = {}) {
  const text = typeof message === 'string' ? message : String(message?.message ?? message ?? '');
  if (!text.trim()) return null;
  const id = `t${++seq}`;
  items = [...items, {
    id,
    level,
    text,
    detail: opts.detail ? String(opts.detail) : null,
    ms: opts.ms ?? DEFAULT_MS[level],
  }];
  emit();
  return id;
}

export const toast = {
  success: (message, opts) => push('success', message, opts),
  error: (message, opts) => push('error', message, opts),
  info: (message, opts) => push('info', message, opts),
};

/** Test hook — the store is module state, so a suite has to be able to clear it. */
export function _resetToasts() {
  items = [];
  seq = 0;
  emit();
}
