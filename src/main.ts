import './style.css';
import {
  AbortedError,
  decodeFrames,
  frameCountFor,
  outputSize,
  probeVideo,
  type VideoInfo,
} from './decode';
import type { EncodeRequest, WorkerResponse } from './types';
import {
  buildReport,
  estimatePeakBytes,
  formatBytes,
  memoryBudget,
  type JobContext,
} from './diagnostics';
import {
  expectedSeconds,
  formatClock,
  formatDuration,
  hasCalibration,
  megapixels,
  recordEncode,
  watchdogSeconds,
} from './estimate';

/* ------------------------------------------------------------------ *
 * Element lookup
 * ------------------------------------------------------------------ */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const dropzone = $<HTMLDivElement>('dropzone');
const fileInput = $<HTMLInputElement>('fileInput');
const editor = $<HTMLElement>('editor');
const preview = $<HTMLVideoElement>('preview');
const fileName = $<HTMLSpanElement>('fileName');
const changeFile = $<HTMLButtonElement>('changeFile');

const trimControl = $<HTMLDivElement>('trimControl');
const trimStart = $<HTMLInputElement>('trimStart');
const trimEnd = $<HTMLInputElement>('trimEnd');
const trimReadout = $<HTMLOutputElement>('trimReadout');

const fpsInput = $<HTMLInputElement>('fps');
const widthInput = $<HTMLInputElement>('width');
const qualityInput = $<HTMLInputElement>('quality');
const loopInput = $<HTMLInputElement>('loop');
const fpsReadout = $<HTMLOutputElement>('fpsReadout');
const widthReadout = $<HTMLOutputElement>('widthReadout');
const qualityReadout = $<HTMLOutputElement>('qualityReadout');

const estimate = $<HTMLDivElement>('estimate');
const convertBtn = $<HTMLButtonElement>('convert');

const progressCard = $<HTMLElement>('progressCard');
const progressLabel = $<HTMLSpanElement>('progressLabel');
const progressNote = $<HTMLParagraphElement>('progressNote');
const barFill = $<HTMLDivElement>('barFill');
const cancelBtn = $<HTMLButtonElement>('cancel');

const about = $<HTMLElement>('about');
const aboutToggle = $<HTMLButtonElement>('aboutToggle');
const aboutClose = $<HTMLButtonElement>('aboutClose');

const result = $<HTMLElement>('result');
const resultImg = $<HTMLImageElement>('resultImg');
const download = $<HTMLAnchorElement>('download');
const gifName = $<HTMLInputElement>('gifName');
const clearName = $<HTMLButtonElement>('clearName');
const startOver = $<HTMLButtonElement>('startOver');
const statSize = $<HTMLElement>('statSize');
const statDims = $<HTMLElement>('statDims');
const statFrames = $<HTMLElement>('statFrames');
const statTime = $<HTMLElement>('statTime');

const errorBox = $<HTMLDivElement>('error');
const errorHeadline = $<HTMLParagraphElement>('errorHeadline');
const errorAdvice = $<HTMLParagraphElement>('errorAdvice');
const errorDetails = $<HTMLDetailsElement>('errorDetails');
const errorReport = $<HTMLPreElement>('errorReport');
const copyReport = $<HTMLButtonElement>('copyReport');
const threadPill = $<HTMLSpanElement>('threadPill');

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let currentFile: File | null = null;
let videoInfo: VideoInfo | null = null;
let previewUrl: string | null = null;
let gifUrl: string | null = null;
let abortController: AbortController | null = null;
let requestId = 0;
let encodeTimer: number | null = null;

/** Scaled to the device — a phone dies far below a desktop's ceiling. */
const BUDGET = memoryBudget();

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)}s`;
};

/* ------------------------------------------------------------------ *
 * Cross-origin isolation indicator
 * ------------------------------------------------------------------ */

if (globalThis.crossOriginIsolated) {
  threadPill.textContent = `${navigator.hardwareConcurrency || '?'}-thread wasm`;
  threadPill.classList.add('on');
} else {
  threadPill.textContent = 'single-thread wasm';
  threadPill.title =
    'Multi-threaded encoding needs cross-origin isolation. Reload the page if this is unexpected.';
}

/* ------------------------------------------------------------------ *
 * View switching
 * ------------------------------------------------------------------ */

type View = 'pick' | 'edit' | 'busy' | 'done';

let currentView: View = 'pick';

function showView(view: View) {
  currentView = view;
  if (aboutOpen) return; // About covers the app; restored when it closes

  dropzone.hidden = view !== 'pick';
  editor.hidden = view !== 'edit';
  progressCard.hidden = view !== 'busy';
  result.hidden = view !== 'done';
}

/* ------------------------------------------------------------------ *
 * About
 * ------------------------------------------------------------------ */

let aboutOpen = false;

function setAbout(open: boolean) {
  aboutOpen = open;
  about.hidden = !open;
  aboutToggle.setAttribute('aria-expanded', String(open));
  aboutToggle.textContent = open ? 'Back' : 'About';

  if (open) {
    dropzone.hidden = true;
    editor.hidden = true;
    progressCard.hidden = true;
    result.hidden = true;
  } else {
    showView(currentView);
  }
}

aboutToggle.addEventListener('click', () => setAbout(!aboutOpen));
aboutClose.addEventListener('click', () => setAbout(false));

/** Simple message with no diagnostic payload (bad file picked, empty trim, ...). */
function showError(message: string) {
  errorHeadline.textContent = message;
  errorAdvice.hidden = true;
  errorDetails.hidden = true;
  errorBox.hidden = false;
}

/**
 * Report a failure with everything needed to reproduce it. There is no server
 * collecting these, so the copyable block is the only path from "it broke" to
 * "it got fixed".
 */
function showFailure(error: unknown, phase: string, job?: JobContext) {
  const report = buildReport(error, phase, job);

  errorHeadline.textContent = report.headline;

  errorAdvice.textContent = report.advice ?? '';
  errorAdvice.hidden = !report.advice;

  errorReport.textContent = report.details;
  errorDetails.hidden = false;
  errorDetails.open = false;

  errorBox.hidden = false;
  console.error('[VidtoGif] %s\n%s', report.headline, report.details);
}

function clearError() {
  errorBox.hidden = true;
  errorHeadline.textContent = '';
  errorAdvice.textContent = '';
  errorReport.textContent = '';
}

copyReport.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(errorReport.textContent ?? '');
    copyReport.textContent = 'Copied';
  } catch {
    // Clipboard access can be denied; selecting the text still works.
    copyReport.textContent = 'Press and hold the text to copy';
  }
  window.setTimeout(() => (copyReport.textContent = 'Copy report'), 2500);
});

/* ------------------------------------------------------------------ *
 * File intake
 * ------------------------------------------------------------------ */

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

for (const type of ['dragenter', 'dragover'] as const) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('hot');
  });
}

for (const type of ['dragleave', 'drop'] as const) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'drop' || event.target === dropzone) dropzone.classList.remove('hot');
  });
}

document.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

changeFile.addEventListener('click', () => fileInput.click());

async function loadFile(file: File) {
  clearError();

  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(file.name)) {
    showError(`"${file.name}" doesn't look like a video file.`);
    return;
  }

  try {
    const { info, revoke } = await probeVideo(file);
    revoke();

    if (!info.width || !info.height) {
      throw new Error('That file has no video track this browser can read.');
    }

    currentFile = file;
    videoInfo = info;

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;

    fileName.textContent = `${file.name} · ${info.width}×${info.height} · ${formatTime(info.duration)}`;

    // Default the width slider to the source width, capped at 640 so the first
    // conversion is quick rather than enormous.
    widthInput.max = String(Math.max(120, info.width));
    widthInput.value = String(Math.min(640, Math.max(120, info.width)));

    trimStart.value = '0';
    trimEnd.value = '100';

    syncReadouts();
    showView('edit');
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

const trimSeconds = (): { start: number; end: number } => {
  const duration = videoInfo?.duration ?? 0;
  return {
    start: (Number(trimStart.value) / 100) * duration,
    end: (Number(trimEnd.value) / 100) * duration,
  };
};

// Keep the two thumbs from crossing; nudge whichever one is being dragged.
function clampTrim(moved: 'start' | 'end') {
  const min = 0.5; // percent
  let a = Number(trimStart.value);
  let b = Number(trimEnd.value);

  if (b - a < min) {
    if (moved === 'start') {
      a = Math.min(a, 100 - min);
      b = a + min;
    } else {
      b = Math.max(b, min);
      a = b - min;
    }
    trimStart.value = String(a);
    trimEnd.value = String(b);
  }
}

function syncReadouts() {
  const { start, end } = trimSeconds();

  trimControl.style.setProperty('--sel-start', `${trimStart.value}%`);
  trimControl.style.setProperty('--sel-end', `${trimEnd.value}%`);
  trimReadout.textContent = `${formatTime(start)} – ${formatTime(end)}`;

  fpsReadout.textContent = `${fpsInput.value} fps`;
  qualityReadout.textContent = qualityInput.value;

  if (videoInfo) {
    const { width, height } = outputSize(videoInfo, Number(widthInput.value));
    widthReadout.textContent = `${width}×${height}`;
  } else {
    widthReadout.textContent = `${widthInput.value} px`;
  }

  updateEstimate();
}

/** Everything about the pending job, for the estimate and for failure reports. */
function currentJob(): JobContext | undefined {
  if (!videoInfo || !currentFile) return undefined;

  const { start, end } = trimSeconds();
  const fps = Number(fpsInput.value);
  const { width, height } = outputSize(videoInfo, Number(widthInput.value));
  const frameCount = frameCountFor(start, end, fps);

  return {
    fileName: currentFile.name,
    fileSize: currentFile.size,
    fileType: currentFile.type,
    sourceWidth: videoInfo.width,
    sourceHeight: videoInfo.height,
    duration: videoInfo.duration,
    trimStart: start,
    trimEnd: end,
    fps,
    outputWidth: width,
    outputHeight: height,
    frameCount,
    quality: Number(qualityInput.value),
    estimatedPeakBytes: estimatePeakBytes(frameCount, width, height),
  };
}

function updateEstimate() {
  const job = currentJob();
  if (!job) return;

  const { frameCount, outputWidth, outputHeight, estimatedPeakBytes: peak } = job;

  const tooBig = peak > BUDGET.hard;
  estimate.classList.toggle('warn', peak > BUDGET.warn);
  convertBtn.disabled = tooBig;

  // Encoding cost climbs steeply at the very top of the quality range: measured
  // here, 100 takes about 4x as long as 80 and produces a far bigger file for a
  // small visual gain. Worth saying at the point the choice is made.
  const qualityNote =
    job.quality >= 100
      ? `<br /><span class="hint">Quality 100 encodes roughly <strong>4× slower</strong> than 90
         and makes a much larger GIF. 90 is usually indistinguishable.</span>`
      : '';

  estimate.innerHTML = tooBig
    ? `<strong>Too big for this device.</strong> ${frameCount} frames at ${outputWidth}×${outputHeight}
       needs about ${formatBytes(peak)}, and ${BUDGET.basis} gives us roughly
       ${formatBytes(BUDGET.hard)} to work with. Reduce the width first — memory scales with
       width × height — then the frame rate or the trim.`
    : `<strong>${frameCount}</strong> frames · <strong>${outputWidth}×${outputHeight}</strong> ·
       about <strong>${formatBytes(peak)}</strong> of memory while encoding.${qualityNote}`;
}

for (const input of [trimStart, trimEnd]) {
  input.addEventListener('input', () => {
    clampTrim(input === trimStart ? 'start' : 'end');
    syncReadouts();
    // Scrub the preview to whichever handle is moving.
    const { start, end } = trimSeconds();
    preview.currentTime = input === trimStart ? start : end;
  });
}

for (const input of [fpsInput, widthInput, qualityInput]) {
  input.addEventListener('input', syncReadouts);
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

const createWorker = () =>
  new Worker(new URL('./gifski.worker.ts', import.meta.url), { type: 'module' });

// Recreated after a cancel: gifski's wasm call is synchronous and has no
// cancellation hook, so the only way to actually stop it is to kill the worker.
let worker = createWorker();

function encodeInWorker(request: EncodeRequest, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Capture the instance up front so cleanup detaches from the same worker
    // even if a cancel swaps in a replacement.
    const active = worker;

    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== request.id) return;
      cleanup();

      if (event.data.type === 'done') {
        resolve(event.data.gif);
        return;
      }

      // Rebuild the error so the report shows where it really came from.
      const error = new Error(event.data.message);
      error.name = event.data.name;
      if (event.data.stack) error.stack = event.data.stack;
      reject(error);
    };

    const onWorkerError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || 'The encoder crashed'));
    };

    const onAbort = () => {
      cleanup();
      // Terminating is the only real cancellation available. Rejecting the
      // promise alone would leave the worker burning CPU inside wasm to produce
      // a GIF nobody is waiting for — noticeable heat and battery on a phone.
      // Killing a dedicated worker also tears down the workers it spawned, so
      // the rayon thread pool goes with it.
      worker.terminate();
      worker = createWorker();
      reject(new AbortedError());
    };

    const cleanup = () => {
      active.removeEventListener('message', onMessage);
      active.removeEventListener('error', onWorkerError);
      signal.removeEventListener('abort', onAbort);
    };

    active.addEventListener('message', onMessage);
    active.addEventListener('error', onWorkerError);
    signal.addEventListener('abort', onAbort, { once: true });

    // Transfer the frame buffers so we don't briefly hold two copies of a
    // multi-hundred-megabyte payload.
    active.postMessage(
      request,
      request.frames.map((frame) => frame.buffer as ArrayBuffer),
    );
  });
}

convertBtn.addEventListener('click', () => void convert());

async function convert() {
  if (!currentFile || !videoInfo) return;

  clearError();
  abortController = new AbortController();
  const { signal } = abortController;
  const startedAt = performance.now();

  // Snapshot the job now: on failure the sliders may have moved, and the report
  // has to describe the run that actually broke.
  const job = currentJob();
  let phase = 'decoding frames';

  showView('busy');
  setProgress(0, 'Reading frames…', '');

  try {
    const { start, end } = trimSeconds();

    const decoded = await decodeFrames({
      file: currentFile,
      start,
      end,
      fps: Number(fpsInput.value),
      width: Number(widthInput.value),
      signal,
      onProgress: (done, total) => {
        setProgress(done / total, 'Reading frames…', `Frame ${done} of ${total}`);
      },
    });

    phase = 'encoding with gifski';

    const frameCount = decoded.frames.length;
    const quality = Number(qualityInput.value);
    const mp = megapixels(frameCount, decoded.width, decoded.height);
    const expected = expectedSeconds(mp, quality);

    startEncodeClock(expected);
    const encodeStartedAt = performance.now();
    const gif = await encodeInWorker(
      {
        id: ++requestId,
        frames: decoded.frames,
        width: decoded.width,
        height: decoded.height,
        frameDurations: decoded.frameDurations,
        quality,
        repeat: loopInput.checked ? 0 : -1,
      },
      signal,
    );

    // Feed the real duration back, so this device's next estimate is grounded
    // in what it actually managed rather than in someone else's hardware.
    recordEncode(mp, quality, performance.now() - encodeStartedAt);
    stopEncodeClock();

    const blob = new Blob([gif as BufferSource], { type: 'image/gif' });
    if (gifUrl) URL.revokeObjectURL(gifUrl);
    gifUrl = URL.createObjectURL(blob);

    resultImg.src = gifUrl;
    download.href = gifUrl;

    // Prefill with the source file's name, which the user can edit before saving.
    gifName.value = sanitiseName(currentFile.name.replace(/\.[^.]+$/, ''));
    syncDownloadName();

    statSize.textContent = formatBytes(blob.size);
    statDims.textContent = `${decoded.width}×${decoded.height}`;
    statFrames.textContent = String(frameCount);
    statTime.textContent = formatTime((performance.now() - startedAt) / 1000);

    showView('done');
  } catch (error) {
    showView('edit');
    if (!(error instanceof AbortedError)) showFailure(error, phase, job);
  } finally {
    stopEncodeClock();
    abortController = null;
  }
}

function setProgress(fraction: number | null, label: string, note: string) {
  progressLabel.textContent = label;
  progressNote.textContent = note;

  if (fraction === null) {
    barFill.classList.add('indeterminate');
  } else {
    barFill.classList.remove('indeterminate');
    barFill.style.width = `${Math.round(fraction * 100)}%`;
  }
}

/**
 * Show elapsed time during encoding, plus what this device's own history
 * suggests. There is deliberately no percentage: gifski reports no progress, so
 * a bar that filled up would be pure fiction.
 */
function startEncodeClock(expected: number | undefined) {
  stopEncodeClock();

  const startedAt = performance.now();
  const warnAt = watchdogSeconds(expected);
  let warned = false;

  const tick = () => {
    const elapsed = (performance.now() - startedAt) / 1000;

    const parts = [`${formatClock(elapsed)} elapsed`];

    if (expected !== undefined) {
      parts.push(`usually about ${formatDuration(expected)} on this device`);
    } else if (!hasCalibration()) {
      parts.push("first encode on this device, so there's nothing to estimate from yet");
    }

    progressNote.textContent = parts.join(' · ');

    if (!warned && elapsed > warnAt) {
      warned = true;
      progressLabel.textContent = 'Still encoding — longer than expected';
      progressCard.classList.add('slow');
    }
  };

  setProgress(null, 'Encoding with gifski…', '');
  tick();
  encodeTimer = window.setInterval(tick, 1000);
}

function stopEncodeClock() {
  if (encodeTimer !== null) {
    window.clearInterval(encodeTimer);
    encodeTimer = null;
  }
  progressCard.classList.remove('slow');
}

/* ------------------------------------------------------------------ *
 * Download file name
 * ------------------------------------------------------------------ */

const FALLBACK_NAME = 'vidtogif';

/**
 * Strip what filesystems reject, so the browser doesn't silently substitute its
 * own name. Also drops a trailing ".gif" — the suffix is shown beside the field,
 * and typing it would otherwise produce "clip.gif.gif".
 */
function sanitiseName(raw: string): string {
  return raw
    .replace(/\.gif$/i, '')
    // Path separators, Windows-reserved characters and control codes.
    // Spaces and hyphens are kept: valid, and people use them in names.
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
}

function syncDownloadName() {
  const name = sanitiseName(gifName.value);
  download.download = `${name || FALLBACK_NAME}.gif`;
}

gifName.placeholder = FALLBACK_NAME;
gifName.addEventListener('input', syncDownloadName);

// Keep the field honest about what will actually be saved.
gifName.addEventListener('blur', () => {
  gifName.value = sanitiseName(gifName.value);
  syncDownloadName();
});

clearName.addEventListener('click', () => {
  gifName.value = '';
  syncDownloadName();
  gifName.focus();
});

cancelBtn.addEventListener('click', () => abortController?.abort());

startOver.addEventListener('click', () => {
  showView('edit');
  clearError();
});

showView('pick');
