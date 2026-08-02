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

const result = $<HTMLElement>('result');
const resultImg = $<HTMLImageElement>('resultImg');
const download = $<HTMLAnchorElement>('download');
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

function showView(view: View) {
  dropzone.hidden = view !== 'pick';
  editor.hidden = view !== 'edit';
  progressCard.hidden = view !== 'busy';
  result.hidden = view !== 'done';
}

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

  estimate.innerHTML = tooBig
    ? `<strong>Too big for this device.</strong> ${frameCount} frames at ${outputWidth}×${outputHeight}
       needs about ${formatBytes(peak)}, and ${BUDGET.basis} gives us roughly
       ${formatBytes(BUDGET.hard)} to work with. Reduce the width first — memory scales with
       width × height — then the frame rate or the trim.`
    : `<strong>${frameCount}</strong> frames · <strong>${outputWidth}×${outputHeight}</strong> ·
       about <strong>${formatBytes(peak)}</strong> of memory while encoding.`;
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

const worker = new Worker(new URL('./gifski.worker.ts', import.meta.url), {
  type: 'module',
});

function encodeInWorker(request: EncodeRequest, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
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
      reject(new AbortedError());
    };

    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onWorkerError);
      signal.removeEventListener('abort', onAbort);
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onWorkerError);
    signal.addEventListener('abort', onAbort, { once: true });

    // Transfer the frame buffers so we don't briefly hold two copies of a
    // multi-hundred-megabyte payload.
    worker.postMessage(
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
    setProgress(null, 'Encoding with gifski…', `${decoded.frames.length} frames · this is the slow part`);

    const frameCount = decoded.frames.length;
    const gif = await encodeInWorker(
      {
        id: ++requestId,
        frames: decoded.frames,
        width: decoded.width,
        height: decoded.height,
        frameDurations: decoded.frameDurations,
        quality: Number(qualityInput.value),
        repeat: loopInput.checked ? 0 : -1,
      },
      signal,
    );

    const blob = new Blob([gif as BufferSource], { type: 'image/gif' });
    if (gifUrl) URL.revokeObjectURL(gifUrl);
    gifUrl = URL.createObjectURL(blob);

    resultImg.src = gifUrl;
    download.href = gifUrl;
    download.download = `${currentFile.name.replace(/\.[^.]+$/, '')}.gif`;

    statSize.textContent = formatBytes(blob.size);
    statDims.textContent = `${decoded.width}×${decoded.height}`;
    statFrames.textContent = String(frameCount);
    statTime.textContent = formatTime((performance.now() - startedAt) / 1000);

    showView('done');
  } catch (error) {
    showView('edit');
    if (!(error instanceof AbortedError)) showFailure(error, phase, job);
  } finally {
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

cancelBtn.addEventListener('click', () => abortController?.abort());

startOver.addEventListener('click', () => {
  showView('edit');
  clearError();
});

showView('pick');
