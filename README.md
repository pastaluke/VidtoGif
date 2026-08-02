# VidtoGif

Turn video into a high-quality GIF, entirely in your browser.

[gifski](https://github.com/ImageOptim/gifski) — the best GIF encoder there is —
compiled to WebAssembly and run on the user's own machine. No upload, no server,
no accounts, no watermarks. The video never leaves the tab.

Free to use and free to host: it's a pile of static files, so GitHub Pages runs
it for nothing.

## How it works

Three pieces, all client-side:

1. **Frame capture** (`src/decode.ts`) — the video is loaded into a `<video>`
   element and played through while `requestVideoFrameCallback` hands back each
   presented frame along with its exact `mediaTime`. Frames are painted straight
   to a canvas at the *output* resolution and read out as RGBA.
2. **Encoding** (`src/gifski.worker.ts`) — frames go to a Web Worker running
   gifski via [`gifski-wasm`](https://github.com/jamsinclair/gifski-wasm), which
   builds cross-frame palettes and applies temporal dithering.
3. **UI** (`src/main.ts`) — trim, frame rate, width, quality, looping, and a
   memory estimate so you know what you're asking for before you ask.

### Why playback capture instead of seeking

The obvious way to grab frames is to seek to each timestamp and paint it. It
works everywhere, but each seek costs roughly 180ms even on a small file, so a
6-second clip took ~25 seconds to read.

Playing the clip once and catching frames as they're presented does the same job
in one linear decode pass. Measured on the same clip and machine, decode went
from ~25s to ~2s, and end-to-end conversion from 32.8s to 5.9s.

Two details make it reliable:

- **Frames are resampled against a moving target time**, not a minimum gap
  between frames. A minimum-gap test rejects any frame arriving slightly early,
  which silently halves the rate whenever source and target are close — a 30fps
  source sampled at 25fps yields 15fps.
- **Playback rate adapts.** The browser presents at most one frame per display
  refresh, so playing at 3x on a 60Hz display yields ~20fps of media time. The
  capture measures what it's actually getting and slows down when the machine
  can't keep up, instead of assuming a refresh rate.

Per-frame durations come from the real `mediaTime` deltas, so if frames *are*
dropped the GIF still plays at the correct speed — it's just slightly choppier.
Seek-based capture remains as a fallback for browsers without
`requestVideoFrameCallback` or if playback capture comes up short.

### Multi-threading on a static host

gifski's parallel build needs `SharedArrayBuffer`, which browsers only expose to
[cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
pages — and static hosts like GitHub Pages can't set response headers.

`public/coi-serviceworker.js` installs a service worker that re-serves
same-origin responses with `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` attached, then reloads once. The badge in the
header shows which mode you got. Without it, `gifski-wasm` falls back to the
single-threaded build automatically — same output, just slower.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + bundle to dist/
npm run preview  # serve the production build
```

The dev and preview servers send the COOP/COEP headers directly, so
multi-threading works locally without the service worker.

## Deploy

`.github/workflows/deploy.yml` builds and publishes `dist/` to GitHub Pages on
every push to `main`. Enable it once under **Settings → Pages → Source → GitHub
Actions**. The build uses a relative base path, so it works both at a domain
root and under `/VidtoGif/`.

Any static host works — Netlify, Cloudflare Pages, S3. If yours *can* set
headers, send COOP/COEP and the service worker becomes unnecessary.

## Limits

- The whole clip is held in memory as RGBA, and gifski concatenates every frame
  into a single buffer, so peak usage is about `frames × width × height × 8`
  bytes. The estimate under the settings shows this; past ~2 GB the convert
  button is disabled rather than letting the tab die.
- Frame capture is bounded by what your machine can present and read back. On a
  slow machine a high frame-rate request produces fewer frames than asked for —
  correctly timed, just choppier.
- Only formats your browser can already play are supported (MP4/H.264 and WebM
  everywhere; MOV/HEVC depends on the browser).

## Licence

[AGPL-3.0-or-later](LICENSE) — gifski itself is AGPL, so anything built on it
inherits that. In practice: use it freely, and if you run a modified version as
a network service, publish your source.

Built on [gifski](https://github.com/ImageOptim/gifski) by Kornel Lesiński and
[gifski-wasm](https://github.com/jamsinclair/gifski-wasm) by Jamie Sinclair.
The cross-origin isolation trick follows Guido Zuidhof's
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker).
