# Finished-cup photos

Put photos of finished, one-of-a-kind cups in this folder. They're served
directly by the site (e.g. `public/cups/fc-001-1.jpg` → `https://<site>/cups/fc-001-1.jpg`).

**Naming:** `‹cup-id›-‹n›.jpg` — e.g. `fc-001-1.jpg` (cover), `fc-001-2.jpg`, `fc-001-3.jpg`.
The first photo is the cover shown in the grid; the rest appear as detail shots.

**Recommended:** square-ish JPG/PNG/WebP, ~1000×1000px, under ~500 KB each.

After adding photos, add the cup to `FINISHED_CUPS` in `server.js` and deploy.
See `docs/finished-cups.md` for the full step-by-step.
