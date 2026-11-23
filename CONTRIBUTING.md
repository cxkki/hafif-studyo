# Contributing to Hafif Stüdyo

Thanks for helping! The project is intentionally small and light: **idle CPU/GPU must stay near 0** (render on demand, no permanent `requestAnimationFrame` loops, no polling timers while idle). Pull requests that break this will be asked to change.

## Setup

```
node -v          # 20+
npm ci
npx neu update   # downloads the Neutralino binaries into bin/
node build.mjs   # bundles src/ -> resources/index.html (use `npm run dev` for watch mode)
node tools/package.mjs   # builds dist/HafifStudyo.exe
```

Read `docs/MIMARI.md` (architecture), `docs/CANLI.md` (live projects) and `docs/TARIF.md` (recipe format) first. These docs are currently in Turkish and are being translated.

## Guidelines

- Plain ES modules in `src/`, no framework. Keep dependencies minimal.
- Every new user-visible string uses `t('module.area.name', 'English text')` from `src/i18n.js`. English is the source language; translations live in `src/locales/<code>.json`.
- Code comments in English.
- Never commit personal data (user names, absolute paths, e-mails, API keys).
- Sample media must be generated or properly licensed.

## Pull requests

1. Fork, create a branch, make a focused change.
2. Make sure `node build.mjs` succeeds.
3. Describe what changed and how you tested it (screenshots help).

By contributing you agree that your contribution is licensed under the MIT license.

## Translations

Add or improve `src/locales/<code>.json` (flat `{ "key": "text" }`). Missing keys fall back to English.
