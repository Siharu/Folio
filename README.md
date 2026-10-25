# Folio

**A personal anime and manga companion.** The opening screen asks which of two independent workspaces to enter:

- **MAL Client** — local anime tracking and MyAnimeList API integration.
- **Manga Crawler** — website inspection, manga discovery, metadata and cover extraction, chapter image extraction, and an in-app reader modal for accessible pages.

## Run locally

Requires Node.js 20 or newer.

```sh
node reconstruct.mjs
npm --prefix folio-app install
npm --prefix folio-app start
```

Open http://localhost:4173.

## Deploy to Render

This repository includes a Render Blueprint in `render.yaml`. In Render choose **New + → Blueprint**, connect `Siharu/Folio`, and deploy the detected `folio` web service. Render reconstructs the source, installs the app, and launches the Node backend. **Do not deploy as a Static Site**: crawler endpoints require a backend.

The complete source archive is stored as numbered base64 chunks in `source-bundle/` and expanded into `folio-app/` during build. This bundle contains the app source, artwork, PWA manifest, service worker, and server.

## MyAnimeList integration status

The current MAL workspace provides local tracking and API configuration hooks. A full OAuth login and callback flow still needs implementation before a live MAL redirect URL should be registered. Never commit client secrets or access tokens; keep confidential credentials on the server.

## Crawler boundaries

Website support varies by source. Folio inspects accessible public HTML, checks robots.txt, and extracts common metadata and image attributes. Some websites need dedicated adapters or JavaScript rendering. Folio does not bypass paywalls, DRM, sign-in restrictions, or anti-bot challenges.
