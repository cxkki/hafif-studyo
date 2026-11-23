# Third-party notices

Hafif Stüdyo itself is MIT licensed (see `LICENSE`). It uses the following third-party software.

| Component | License | Use |
|---|---|---|
| [three.js](https://threejs.org) r170 | MIT | 3D rendering, loaders and exporters (bundled into the app) |
| [Neutralinojs](https://neutralino.js.org) 6.x | MIT | Desktop runtime (native window, filesystem APIs, packaging) |
| [esbuild](https://esbuild.github.io) | MIT | Build tool only; not shipped |
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | MIT | Optional: used only if you connect Claude with your own API key |
| [FFmpeg](https://ffmpeg.org) | LGPL/GPL (depends on build) | **Not bundled.** Optional; you install it yourself (MP4 conversion, screen-recorded build videos) |

On Windows the app uses the Microsoft Edge WebView2 runtime, which is provided by the operating system / Microsoft and not redistributed here.

## Sample media

All sample media in `ornekler/medya` and `sablonlar/_ortak` (logo, music, video) is generated procedurally by this project and contains no third-party material.

Each license text is available in the respective package under `node_modules/<package>/LICENSE`.
