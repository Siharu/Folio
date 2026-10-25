# Folio

**Your personal anime and manga companion.** At launch, choose one of two separate workspaces:

- **MAL Client** — local anime tracking and MyAnimeList API integration.
- **Manga Crawler** — public website inspection, manga discovery, cover and metadata extraction, chapter image extraction, and an in-app reader modal for accessible pages.

## Run locally

Requires Node.js 20 or newer.

```sh
node reconstruct.mjs
npm --prefix folio-app install
npm --prefix folio-app start
```

Open http://localhost:4173.

## Deploy to Render

This repository includes a Render Blueprint at `render.yaml`. In Render select **New + → Blueprint**, connect `Siharu/Folio`, and deploy the detected `folio` web service. Render reconstructs the complete app, installs it, and launches the Node backend. **Do not deploy it as a Static Site**: the crawler needs a backend.

The complete source archive is committed in `source-bundle/`. A GitHub Actions workflow reconstructs it and commits the readable application files into `folio-app/`; the Render build also reconstructs these files, so every deployment can be rebuilt from the source bundle.

## MyAnimeList integration status

The current MAL workspace provides local tracking and API configuration hooks. A complete OAuth login/callback flow still needs implementation before a live MAL redirect URL should be registered. Never commit client secrets or access tokens; confidential credentials must stay server-side.

## Crawler boundaries

Website support varies by source. Folio inspects accessible public HTML, checks robots.txt, and extracts common metadata and image attributes. Some websites need dedicated adapters or JavaScript rendering. Folio does not bypass paywalls, DRM, sign-in restrictions, or anti-bot challenges.
