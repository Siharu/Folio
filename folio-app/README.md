# Folio — Anime & Manga After Hours

A runnable, local-first app shell with two separate functions and a bespoke “Night Edition” visual design: layered manga-cover art, a hand-built neon-night city illustration, anime-magazine typography, and distinct violet MAL / cyan manga themes.

1. **MAL Client** — manage a local anime list; with your own MyAnimeList API Client ID and valid access token, search MAL, load your account's anime list, and update status / watched episodes / score.
2. **Manga Crawler** — inspect a public website URL, read title and cover metadata, heuristically collect same-site manga/chapter links, save websites, and maintain a personal manga library.

## Run it

Requires Node.js 20 or newer. No third-party npm packages are required.

```bash
npm start
```

Then open <http://localhost:4173>.

Do **not** open `index.html` directly as a `file://` URL. The backend is needed for website inspection and MAL API requests. The interface's local lists work in the browser.

## MyAnimeList setup

- Create/configure your own app in MyAnimeList's API settings.
- Supply your API Client ID and a valid MAL OAuth access token in **MAL Client → Connection & help**.
- The app does not ask for or store your MAL password. In this starter, the access token is held in `sessionStorage` for the current tab session; the Client ID is saved locally.
- A dedicated OAuth sign-in/callback flow is not implemented yet. Obtain tokens only through MAL's supported authorization flow, and never paste a token into a copy of the app you do not trust.

## Crawler notes

- The generic crawler checks `robots.txt`, observes a per-host cooldown, caps pages at 2 MB, follows a limited number of public redirects, and blocks localhost/private/reserved IP targets.
- It uses heuristic HTML extraction, not a universal parser. Some sites require dedicated source adapters; client-rendered catalogs, unusual page structures, CAPTCHAs, access controls, and protected images will not necessarily work.
- It does not bypass login requirements, paywalls, DRM, or anti-bot challenges. Use only sources and content you are entitled to access, and respect the site's terms and applicable law.
- This is a starter version, not a guarantee of compatibility with every manga website.

## Storage

Anime list, manga library, and saved source metadata are stored in this browser's `localStorage`. Clearing browser site data removes those entries. Export/import and cloud sync are not included yet.

## In-app chapter reader (starter)

The Manga Crawler now includes `POST /api/chapter-images`. When you open a saved manga and choose **Read in Folio**, the backend checks the chapter URL against its public robots.txt rules, inspects the publicly served HTML, extracts common image/lazy-load attributes, and renders the discovered images in a scrollable reader modal.

This generic extraction works only when chapter images are present in accessible HTML. Sites that render images with JavaScript, use signed/protected image delivery, or require authentication may need a dedicated source adapter. The app does not bypass those controls. For best results, inspect a manga's actual chapter URL rather than a homepage.

## Find manga websites

In Manga Crawler → Website discovery, use **Find manga websites** to search for a title or phrase. When direct result retrieval is available, Folio displays candidate pages with **Inspect with Folio** and **Save website** actions. If the server cannot retrieve search results, it offers DuckDuckGo, Bing, and Google search links; open a search result and paste its public URL into **Inspect a manga website**. Crawling still checks public URL safety and robots.txt, and does not bypass sign-ins, paywalls, DRM, or access controls.


## Night Edition design

- The home screen remains a two-choice launcher: **MAL Client** or **Manga Crawler**.
- `assets/folio-night-scene.svg` is original vector artwork bundled with the app; the new hero visuals do not depend on an external image CDN.
- The interface has separate visual accents for each workspace, a floating-cover carousel, responsive mobile layouts, and reduced-motion support.
- `icon.svg`, the PWA manifest, and service-worker shell cache match the updated branding.

## Publishing from GitHub

This is a full-stack Node.js app, not a static-only site. GitHub Pages alone cannot run `server.mjs`, the crawler endpoints, or the MAL API proxy. The included `render.yaml` is a Render Blueprint so a connected GitHub repository can deploy the Node service and serve both the frontend and backend at one HTTPS origin.

Before using a public URL for MyAnimeList OAuth, implement the OAuth authorization-code callback and token exchange. The present starter does not yet implement a full MAL sign-in flow; do not register a made-up callback path. Keep client secrets and OAuth tokens out of the repository and frontend bundle. Use the exact callback URL provided by the deployed application's implemented route.
