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

`main` is the live branch. `.github/workflows/deploy.yml` builds and publishes
`dist/` to GitHub Pages on every push to it (Pages source is set to **GitHub
Actions**). The build uses a relative base path, so it works both at a domain
root and under `/VidtoGif/`.

Feature work happens on branches and gets verified in a throwaway environment
before merging — see the section below for what that looked like in practice.

One gotcha worth knowing if you fork this. The `github-pages` environment is
created the moment you enable Pages, and it pins a **deployment branch
allowlist** to whatever the default branch was at that instant. Renaming or
switching the default branch later does *not* update that allowlist, so
deploying from `main` gets rejected:

```
Branch "main" is not allowed to deploy to github-pages
due to environment protection rules.
```

Fix it at Settings → Environments → `github-pages` → "Deployment branches and
tags" (add `main`, or remove the restriction) — not at Settings → General →
Default branch, which looks like the culprit but isn't.

Two things make this hard to diagnose: `build` succeeds and only `deploy` fails,
in about two seconds with no steps, so it reads as a silent non-failure. And
because the job never starts it produces no logs — `.../jobs/<id>/logs` returns
404. The error is in the check run's **annotations**, which is a different API
surface and the only place it appears.

Any static host works — Netlify, Cloudflare Pages, S3. If yours *can* set
headers, send COOP/COEP and the service worker becomes unnecessary.

## Why there's no progress bar

gifski's wasm binding exports exactly one function, `encode`, with no progress
callback and no cancellation hook. The call is synchronous, so the worker's event
loop is blocked for its entire duration and cannot even emit a heartbeat. There
is no progress signal to read — a bar that filled up would be animation, not
information.

So the encode phase shows what is actually true:

- **Elapsed time**, counting up.
- **What this device has managed before.** Each completed encode records its
  seconds-per-megapixel in `localStorage`, bucketed by quality. The first encode
  on a device says plainly that there's nothing to estimate from yet; later ones
  say "usually about 40s on this device". Nothing is seeded from the developer's
  machine, because a desktop number would be a lie on a phone.
- **A watchdog, not a timeout.** Past ~2.5× the device's own history it says so
  and leaves the decision to you. It never kills a running encode: a big job on a
  slow phone legitimately takes minutes, and silently discarding that work would
  be worse than the wait.

Cancel genuinely stops the work. Since wasm exposes no cancellation, the worker
is terminated outright and a fresh one replaces it — otherwise it would keep
burning CPU producing a GIF nobody is waiting for.

### Quality is the expensive dial

Measured on the same 80-frame 480×270 job:

| quality | time | vs 80 | GIF size |
|---|---|---|---|
| 60 | 3.21s | 1.05× | 0.23 MB |
| 80 | 3.05s | 1.00× | 0.57 MB |
| 90 | 5.16s | 1.69× | 0.93 MB |
| 95 | 5.86s | 1.92× | 1.45 MB |
| 100 | 12.34s | **4.05×** | 3.38 MB |

The cliff is at 100 specifically. It costs four times the encoding time of 80 and
produces a file six times larger, for a difference most people can't see — so the
settings panel says so when you select it.

## When it fails

There is no server, so there is no error reporting either — nobody sees a crash
unless the page shows it. A failed conversion therefore renders a plain-language
cause, and a copyable report carrying the device, the job settings and the raw
error, ready to paste into an issue.

This matters because the failure that actually shipped was a wasm panic, which
reaches JavaScript as the single word `unreachable`. On its own it says nothing;
in practice it always means gifski exhausted its memory.

## Limits

- The whole clip is held in memory as RGBA. Peak usage is about
  `frames × width × height × 4 × 3.2` — three copies exist at once (the decoded
  frames in JS, the single buffer `gifski-wasm` concatenates them into, and that
  buffer copied into wasm linear memory) plus gifski's own working set.
- The budget scales to the device rather than assuming a desktop: wasm32 is
  capped at 4 GB by specification and browsers fall over well before that,
  phones dramatically so. `navigator.deviceMemory` narrows it further where the
  browser reports it. Past that budget the convert button is disabled, with the
  numbers shown, instead of letting the tab die mid-encode.
- Width is the most effective dial, since memory scales with width × height.
- Frame capture is bounded by what your machine can present and read back. On a
  slow machine a high frame-rate request produces fewer frames than asked for —
  correctly timed, just choppier.
- Only formats your browser can already play are supported (MP4/H.264 and WebM
  everywhere; MOV/HEVC depends on the browser).

## If you're curious: how this got built

The path from empty repo to working site, including the wrong turns. Each step
is roughly "what I assumed → what measuring it actually showed".

**1. Find a gifski that runs in a browser.**
`gifski-wasm` on npm wraps upstream gifski. Reading the package before writing
any code settled three things: `encode()` takes *all* frames as one buffer (so
memory, not CPU, is the hard limit), there's no progress callback (so the encode
bar has to be indeterminate), and it ships both a single-threaded and a
rayon-parallel build with automatic fallback (so multi-threading is a bonus, not
a requirement).

**2. Capture frames at output size, not source size.**
300 frames of 1080p RGBA is ~2.5 GB. The same clip at 480px wide is ~155 MB.
Drawing the video straight to the target dimensions instead of resizing later
makes the difference between working and killing the tab.

**3. Get a test video.**
The container's ffmpeg turned out to be stripped down — no `lavfi`, no PNG
decoder, no `rawvideo`. Rather than fight it, I had Chromium record a canvas
animation via `MediaRecorder`. The animation is a square moving left to right,
chosen so a wrong or repeated frame is detectable later by arithmetic, not by
eye.

**4. First test passed. It shouldn't have.**
Every panel was on screen from page load, so the test was reading empty
placeholders and calling it success. Cause: `.editor { display: grid }` outranks
the browser's built-in `[hidden] { display: none }`, so the `hidden` property
did nothing. Fixed by restating it in the stylesheet. Lesson applied for the
rest of the build: assert on *content*, not on whether an element is visible.

**5. It worked, but it was slow.**
A 6s 720p clip took 32.8s. Timing the phases separately: 25.6s reading frames,
7.1s in gifski. So decoding was the problem, not the encoder.

**6. Benchmark the alternatives instead of guessing.**
Four capture strategies, same clip, same machine. The first run hung outright —
which was itself the finding: `requestVideoFrameCallback` never fires after
seeking a paused video, so waiting on it blocks forever. With timeouts added:

| strategy | result |
|---|---|
| seek + rVFC, 120ms cap | 298ms/frame — rVFC fired **0** times, so the cap was paid in full every frame |
| seek + `seeked` event only | 178ms/frame |
| play at 1x, catch frames | real time |
| play at 4x, catch frames | **8x faster** than seeking |

Seeking costs ~180ms each because it's a fresh decode every time. Playing once
decodes linearly. Switched the primary path to playback capture and deleted the
dead rVFC wait from the seek path, which stayed on as a fallback.

Result: 32.8s → 6.4s.

**7. Check the frames are right, not just that a GIF appeared.**
A valid GIF header proves nothing about content. A harness calling the decoder
directly checked three things: every frame hashes differently, the moving
square's horizontal position increases monotonically, and the frame durations
sum to the clip length. It caught a real shortfall — 60 frames captured where 89
were asked for.

**8. Stop assuming 60Hz.**
The browser presents at most one frame per display refresh, so playing at 3x on
a 60Hz display yields ~20fps of media. This container presents at 30Hz, so 3x
yielded 10fps. Rather than hardcode a different number, the capture now measures
the rate it's actually achieving and slows down when it falls behind.

**9. A 25fps request took 30 seconds. Reproducibly.**
Two bugs compounding. First, sampling used a minimum gap between frames, which
rejects any frame arriving slightly early — a 30fps source sampled at 25fps
degrades to 15fps. Second, that shortfall tripped the "playback failed" check,
triggering a *full* seek-based re-decode on top of the playback pass. Both
strategies, paid in full.

Fixed by resampling against a moving target timestamp instead of a gap, and by
judging the result against what the source can actually supply rather than what
was requested. Asking 50fps of a 30fps clip is not a failure, and re-running the
slow path would only produce duplicates.

**10. The same request gave different answers on different runs.**
Source frame rate was being estimated from the *smallest* gap between frames,
which one anomalously short gap ruins. One 50fps run gave 175 frames in 6s; the
next gave 298 frames in 53s, 112 of them duplicates. Switched to the median gap.
Stable across repeated runs.

**11. Verify the deployment story, not just the app.**
Multi-threading needs headers GitHub Pages can't send. Tested the service worker
against a plain static server with no headers at all: it registered, reloaded
once, and the page came back cross-origin isolated on 4 threads. Then tested
with service workers blocked entirely — single-threaded output was byte-identical,
just slower. Both paths are real, so neither is a guess.

**12. Final pass.** Frame rates 10–50fps, both threading modes, trim, cancel,
and the memory guard at its warn and hard-block thresholds.

## Licence

[AGPL-3.0-or-later](LICENSE) — gifski itself is AGPL, so anything built on it
inherits that. In practice: use it freely, and if you run a modified version as
a network service, publish your source.

Built on [gifski](https://github.com/ImageOptim/gifski) by Kornel Lesiński and
[gifski-wasm](https://github.com/jamsinclair/gifski-wasm) by Jamie Sinclair.
The cross-origin isolation trick follows Guido Zuidhof's
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker).
