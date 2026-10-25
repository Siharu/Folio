# Hekomi

**Your personal anime and manga companion.** At launch, choose one of two independent workspaces:

- **MAL Client** — search anime, view your list, update status/score/episodes, and sync with your own MyAnimeList account.
- **Manga Crawler** — discover permitted public manga websites, extract covers and metadata, inspect chapters, and read detected chapter images inside Hekomi.

## Run locally

Requires Node.js 20 or newer.

```sh
npm --prefix folio-app start
```

Open http://localhost:4173. Manga crawling works locally. MAL OAuth requires environment variables: `MAL_CLIENT_ID`, `MAL_CLIENT_SECRET`, and `FOLIO_SESSION_SECRET`. For local development, use an API app registration whose redirect URL is `http://localhost:4173/api/mal/auth/callback`.

## Deploy to Render

1. In Render choose **New + → Blueprint** and connect `Siharu/Folio`.
2. Review the Web Service Blueprint; do **not** choose Static Site, because the manga crawler requires a Node.js backend.
3. Enter the MAL application's **Client ID** and **Client Secret** into the Render environment prompts. Render generates `FOLIO_SESSION_SECRET` for encrypted sessions.
4. After Render gives the service its HTTPS URL, update the app's **App Redirect URL** in [MAL API Configuration](https://myanimelist.net/apiconfig) to the exact URL `https://YOUR-SERVICE.onrender.com/api/mal/auth/callback`. Keep it exact, including the path.
5. Open Hekomi, choose **MAL Client**, and tap **Sign in with MyAnimeList**.

The developer registers the MAL app once. Every user authorizes their own account; users do not create API registrations or paste tokens. Hekomi exchanges OAuth codes on the server, stores access/refresh tokens in an encrypted HttpOnly cookie, and refreshes tokens as needed. The Client Secret and session encryption key are server-only and must never be committed to GitHub or placed in HTML.

## Appearance themes

Hekomi includes **Midnight**, **Late Night**, and **Dawn** themes, plus **Device Settings**, which follows the operating system’s light/dark preference. Your selection is saved locally on this device.

## Crawler boundaries

Website support varies by source. Hekomi inspects accessible public HTML, checks robots.txt, and extracts common metadata and image attributes. Some websites need dedicated adapters or JavaScript rendering. Hekomi does not bypass paywalls, DRM, sign-in restrictions, or anti-bot challenges.
