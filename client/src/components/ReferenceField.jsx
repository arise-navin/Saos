import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Generic typeahead. `fetchOptions(q)` must resolve to [{ id, label, sub? }].
 * `value` is { id, label } | null. Selected value renders as a removable chip.
 */
export function Typeahead({ fetchOptions, value, onChange, placeholder }) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const wrap = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const search = (text) => {
    setQ(text);
    setOpen(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try { setOptions(await fetchOptions(text)); }
      catch { setOptions([]); }
      finally { setLoading(false); }
    }, 280);
  };

  if (value) {
    return (
      <div className="ref-chip">
        <span>{value.label}</span>
        <span className="mono">{value.id.slice(0, 8)}…</span>
        <button type="button" aria-label="Clear" onClick={() => onChange(null)}>×</button>
      </div>
    );
  }

  return (
    <div className="ref-field" ref={wrap}>
      <input
        className="input"
        value={q}
        placeholder={placeholder || 'Type to search…'}
        onChange={(e) => search(e.target.value)}
        onFocus={() => q && setOpen(true)}
      />
      {open && (
        <div className="ref-menu">
          {loading && <div className="ref-opt">Searching…</div>}
          {!loading && options.length === 0 && <div className="ref-opt">No matches</div>}
          {!loading && options.map((o) => (
            <div
              key={o.id}
              className="ref-opt"
              onClick={() => { onChange(o); setOpen(false); setQ(''); }}
            >
              {o.label}{o.sub ? <span className="mono"> · {o.sub}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Reference field bound to a ServiceNow table (sys_user, sys_user_group, …). */
export default function ReferenceField({ table, value, onChange, placeholder }) {
  return (
    <Typeahead
      placeholder={placeholder || `Search ${table}…`}
      fetchOptions={async (q) =>
        (await api.get(`/system/reference/${table}?q=${encodeURIComponent(q)}`)).map((r) => ({
          id: r.sys_id,
          label: r.display,
        }))}
      value={value}
      onChange={onChange}
    />
  );
}

/** Table picker (sys_db_object) — stores the table *name* as id. */
export function TableField({ value, onChange, placeholder }) {
  return (
    <Typeahead
      placeholder={placeholder || 'Search tables…'}
      fetchOptions={async (q) =>
        (await api.get(`/system/tables?q=${encodeURIComponent(q)}`)).map((t) => ({
          id: t.name,
          label: t.label,
          sub: t.name,
        }))}
      value={value}
      onChange={onChange}
    />
  );
}
