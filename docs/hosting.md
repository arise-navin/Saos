# Vercel frontend and Render backend

## Render

Create a Blueprint from this repo. `render.yaml` installs `server/`, starts
`server/src/index.js`, exposes `/healthz`, and mounts a persistent disk at
`/var/data/saos` for the current SQLite-backed app data.

Set these Render environment variables:

- `FRONTEND_ORIGIN`: your Vercel origin, for example `https://saos.vercel.app`
- `API_ACCESS_TOKEN`: a long secret used by the frontend to call `/api`
- `SAOS_DATA_DIR`: `/var/data/saos`

The Turso URL/token must stay secret. This codebase is not yet wired to libSQL,
so Render persistence currently comes from the mounted disk.

## Vercel

Keep the Vercel project root at the repository root. `vercel.json` builds only
`client/` and serves `client/dist`.

Set this Vercel environment variable:

- `VITE_API_URL=https://YOUR-RENDER-SERVICE.onrender.com/api`

For the backend token, store it in the browser after deploy:

```js
localStorage.setItem('saos.apiToken', 'YOUR_RENDER_API_ACCESS_TOKEN')
```

Then refresh the app.

## Ollama

Render cannot reach `localhost` on your laptop. To use your local Ollama from
the hosted backend, expose it through an authenticated HTTPS tunnel/proxy and
set that `/v1` URL in the SAOS Settings page. Do not use bare localhost in
production settings.
