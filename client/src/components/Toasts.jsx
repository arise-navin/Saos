import { useEffect, useState } from 'react';
import { subscribeToasts, dismissToast } from './toast.js';

/**
 * The toast host. Mounted once, at the app root.
 *
 * Two accessibility properties that are easy to get wrong and matter here:
 * the region is `aria-live` so a screen reader announces an outcome that
 * appeared in a corner the user was not looking at, and errors are
 * `assertive`/`role="alert"` while successes are `polite` — a "saved" toast
 * interrupting whatever is being read is worse than useless.
 *
 * Auto-dismiss pauses on hover and on keyboard focus. A toast that vanishes
 * mid-read while you are tabbing towards its dismiss button is the classic
 * failure of this pattern.
 */

function Toast({ item }) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held || !item.ms) return undefined;
    const t = setTimeout(() => dismissToast(item.id), item.ms);
    return () => clearTimeout(t);
  }, [held, item.id, item.ms]);

  const isError = item.level === 'error';
  return (
    <div
      className={`toast ${item.level}`}
      role={isError ? 'alert' : 'status'}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="toast-body">
        <div className="toast-text">{item.text}</div>
        {item.detail && <div className="toast-detail mono">{item.detail}</div>}
      </div>
      <button className="toast-x" onClick={() => dismissToast(item.id)} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}

export default function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => subscribeToasts(setItems), []);
  if (items.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {items.map((t) => <Toast key={t.id} item={t} />)}
    </div>
  );
}
