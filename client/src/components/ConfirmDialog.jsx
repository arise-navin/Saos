import { useCallback, useEffect, useRef, useState } from 'react';
import { registerConfirmHost } from './confirm.js';

/**
 * D-2 — the dialog that replaced every `window.confirm`.
 *
 * Mounted once at the app root; `confirm.js` routes every call here. What the
 * native modal could not do, and why this exists rather than being a re-skin:
 *
 *  - it shows the exact target. A label is not unique on a ServiceNow
 *    instance, so the sys_id is printed in mono next to it. "Delete variable
 *    justification" is not enough information to decide with.
 *  - it states the consequence. `CONSEQUENCE.variable` is the difference
 *    between deleting a variable and silently breaking every UI policy that
 *    names it.
 *  - the destructive button is styled as destructive, and is NOT focused.
 *    Cancel takes focus, so Enter and Escape both mean "no" — the only two
 *    keys someone dismissing a surprise dialog is likely to hit.
 *
 * Focus is trapped and restored to whatever opened the dialog, because losing
 * your place in a table after cancelling a delete is its own small failure.
 */

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function ConfirmDialog() {
  const [request, setRequest] = useState(null);
  const resolver = useRef(null);
  const panel = useRef(null);
  const cancelBtn = useRef(null);
  const field = useRef(null);
  const opener = useRef(null);
  const [draft, setDraft] = useState('');

  useEffect(
    () =>
      registerConfirmHost((req) => {
        opener.current = document.activeElement;
        setDraft(req.value ?? '');
        setRequest(req);
        return new Promise((resolve) => { resolver.current = resolve; });
      }),
    []
  );

  const close = useCallback((answer) => {
    setRequest(null);
    const resolve = resolver.current;
    resolver.current = null;
    // Give focus back before resolving, so a caller that re-renders the list
    // does not race the restore.
    if (opener.current?.focus) { try { opener.current.focus(); } catch { /* element gone */ } }
    opener.current = null;
    resolve?.(answer);
  }, []);

  // A prompt opens on its input (you came here to type); a destructive confirm
  // opens on Cancel (you may have come here by accident).
  useEffect(() => {
    if (!request) return;
    if (request.kind === 'prompt') { field.current?.focus(); field.current?.select(); }
    else cancelBtn.current?.focus();
  }, [request]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(request.kind === 'prompt' ? null : false); return; }
    if (e.key !== 'Tab') return;
    const nodes = [...(panel.current?.querySelectorAll(FOCUSABLE) || [])].filter((n) => !n.disabled);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  if (!request) return null;

  const isPrompt = request.kind === 'prompt';
  const title = request.subject ? `${request.action} “${request.subject}”?` : `${request.action}?`;

  const submit = (e) => {
    e?.preventDefault?.();
    close(isPrompt ? draft : true);
  };

  return (
    <div className="dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(isPrompt ? null : false); }}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={panel}
        onKeyDown={onKeyDown}
      >
        <h2 className="dialog-title" id="dialog-title">{isPrompt ? request.action : title}</h2>

        {/* The exact record, not just its label. */}
        {request.sysId && (
          <div className="dialog-target">
            <span className="label">target</span>
            <span className="mono">{request.sysId}</span>
          </div>
        )}

        {request.detail && <p className="dialog-detail">{request.detail}</p>}

        {isPrompt ? (
          <form className="field" onSubmit={submit}>
            <label className="label" htmlFor="dialog-input">{request.label || 'Value'}</label>
            <input
              id="dialog-input"
              className="input"
              ref={field}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </form>
        ) : null}

        <div className="dialog-actions">
          <button className="btn" ref={cancelBtn} onClick={() => close(isPrompt ? null : false)}>
            Cancel
          </button>
          <button
            className={`btn ${request.danger ? 'danger' : 'primary'}`}
            onClick={submit}
            disabled={isPrompt && !draft.trim()}
          >
            {request.confirmLabel || (request.danger ? 'Delete' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
