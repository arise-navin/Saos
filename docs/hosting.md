# Vercel frontend and Render backend

## Render

Create a Blueprint from this repo. `render.yaml` installs `server/`, installs
the ServiceNow SDK workspace with dev dependencies, starts `server/src/index.js`,
and exposes `/healthz`.

Set these Render environment variables:

- `FRONTEND_ORIGIN`: your Vercel origin, for example `https://saos.vercel.app`
- `API_ACCESS_TOKEN`: a long secret used by the frontend to call `/api`
- `SAOS_DATA_DIR`: `/tmp/saos` on Render free, or a mounted persistent disk path on a paid service

The current backend stores app users, sessions, saved ServiceNow credentials,
LLM settings, chats, and scan state in its SQLite database. On Render free,
`/tmp` survives ordinary page reloads but not guaranteed service restarts or
redeploys. For permanent production persistence use a Render persistent disk or
convert the storage layer to Turso/libSQL.

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

The first page is now a SAOS account screen. Create the first user with name,
email, and password; later visits require that login before the dashboard opens.
Groq can be selected from Settings and uses the API key entered in the UI.

## Ollama

Render cannot reach `localhost` on your laptop. To use your local Ollama from
the hosted backend, expose it through an authenticated HTTPS tunnel/proxy and
set that `/v1` URL in the SAOS Settings page. Do not use bare localhost in
production settings.
