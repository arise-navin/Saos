import { useEffect, useState } from 'react';
import { api } from '../api.js';

const empty = { name: '', email: '', password: '' };

export default function AuthGate({ children }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/system/auth/status').then(setStatus).catch((e) => {
    setStatus({ configured: false, authenticated: false });
    setError(e.message);
  });

  useEffect(() => { load(); }, []);

  if (!status) return null;
  if (status.authenticated) return children;

  const mode = status.configured ? 'login' : 'register';
  const title = mode === 'register' ? 'Create SAOS user' : 'Login to SAOS';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await api.post(mode === 'register' ? '/system/auth/register' : '/system/auth/login', form);
      localStorage.setItem('saos.userToken', result.session.token);
      setForm(empty);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="auth-mark">S</div>
        <div>
          <h1>{title}</h1>
          <p>After this, connect your ServiceNow instance from the dashboard.</p>
        </div>
        <form className="stack" onSubmit={submit}>
          {mode === 'register' && (
            <div className="field">
              <label className="label">Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" required />
            </div>
          )}
          <div className="field">
            <label className="label">Email ID</label>
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" required />
          </div>
          <div className="field">
            <label className="label">Password</label>
            <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={8} />
          </div>
          <button className="btn primary" disabled={busy} aria-busy={busy}>
            {busy ? 'Please wait...' : mode === 'register' ? 'Create user' : 'Login'}
          </button>
          {error && <p className="error-text">{error}</p>}
        </form>
      </div>
    </div>
  );
}
