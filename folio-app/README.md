# Folio Night Edition

Folio is a two-mode personal anime and manga app: **MAL Client** and **Manga Crawler**.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open http://localhost:4173.

## MyAnimeList setup (developer only)

Register **one** MAL application at https://myanimelist.net/apiconfig. Configure the app's environment variables on the server:

- `MAL_CLIENT_ID` — shared app Client ID (not a per-user value).
- `MAL_CLIENT_SECRET` — private app credential; server only.
- `FOLIO_SESSION_SECRET` — strong encryption key for per-user OAuth sessions.

For local development, add `http://localhost:4173/api/mal/auth/callback` as the app's redirect URL. For production, register the exact HTTPS callback URL: `https://YOUR-SERVICE.onrender.com/api/mal/auth/callback`.

Users click **Sign in with MyAnimeList**, authorize their own account on MAL, and return to Folio. OAuth code exchange and refresh happen server-side. Each user's access/refresh tokens are isolated inside an encrypted HttpOnly cookie; tokens aren't put in browser storage or requested manually. No Client ID or Client Secret should be hardcoded into this repository.

## Deploy

Use the root `render.yaml` Blueprint on Render. This is a **Node web service**, not a Static Site, because the crawler and OAuth callback run in the Node backend. The source files are in `folio-app/`; source-bundle chunks are just an archive copy and aren't used during the Render build.
