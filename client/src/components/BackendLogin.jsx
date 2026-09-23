import { useState } from 'react';
import { API_BASE, REMOTE_BACKEND, backendFetch, setAccessToken, getAccessToken } from '../backend.js';

export default function BackendLogin({ children }) {
  const [ready, setReady] = useState(!REMOTE_BACKEND);
  const [value, setValue] = useState(getAccessToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (ready) return children;
  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setAccessToken(value.trim());
    try {
      const response = await backendFetch(`${API_BASE}/system/health`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Invalid access token.' : `Backend unavailable (${response.status}).`);
      const health = await response.json();
      if (!health.ok) throw new Error('Backend is not ready.');
      setValue('');
      setReady(true);
    } catch (err) {
      setAccessToken('');
      setError(err.message);
    } finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 420, margin: '64px auto', padding: 24 }}>
    <h1>SAOS</h1>
    <form onSubmit={login}>
      <label htmlFor="access-token">Access token</label>
      <input className="input" id="access-token" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} required style={{ width: '100%', margin: '12px 0' }} />
      <button className="btn primary" disabled={busy}>{busy ? 'Connecting...' : 'Sign in'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  </main>;
}
