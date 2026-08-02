/**
 * Client-side failure reporting.
 *
 * Nothing here phones home — the whole point of the app is that your video never
 * leaves the tab, so there is no server collecting errors either. That means the
 * only way anyone can act on a failure is if the page hands the user a report
 * good enough to paste into an issue.
 *
 * A raw wasm panic surfaces as the single word "unreachable", which tells a user
 * nothing. So we do two things: translate the common failures into plain
 * language, and attach the device/job context needed to reproduce them.
 */

export interface JobContext {
  fileName: string;
  fileSize: number;
  fileType: string;
  sourceWidth: number;
  sourceHeight: number;
  duration: number;
  trimStart: number;
  trimEnd: number;
  fps: number;
  outputWidth: number;
  outputHeight: number;
  frameCount: number;
  quality: number;
  estimatedPeakBytes: number;
}

export interface FailureReport {
  /** Plain-language explanation shown to the user. */
  headline: string;
  /** Longer advice, when we know what to suggest. */
  advice?: string;
  /** Full copyable report. */
  details: string;
}

/** True when the device is a phone/tablet, where wasm memory ceilings are far lower. */
export function isMobile(): boolean {
  const data = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof data?.mobile === 'boolean') return data.mobile;
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
}

/** Device RAM in GB where the browser reports it (Chromium only), else undefined. */
export function deviceMemoryGb(): number | undefined {
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Peak bytes a job will need.
 *
 * Three copies of the frame data exist at once during encoding:
 *   1. the decoded RGBA frames held in JS,
 *   2. the single concatenated buffer gifski-wasm builds from them,
 *   3. that buffer copied into wasm linear memory.
 * Plus gifski's own working set for palettes and quantisation, which we
 * approximate generously rather than pretend is free.
 */
export function estimatePeakBytes(
  frameCount: number,
  width: number,
  height: number,
): number {
  const raw = frameCount * width * height * 4;
  return Math.round(raw * 3.2);
}

/**
 * How much we're willing to let a job allocate before refusing to start it.
 *
 * wasm32 tops out at 4GB of linear memory by specification, and real browsers
 * fall over well before that — dramatically so on phones, which is exactly where
 * the first crash showed up. Scale to the device rather than assuming a desktop.
 */
export function memoryBudget(): { hard: number; warn: number; basis: string } {
  const mobile = isMobile();
  const ram = deviceMemoryGb();

  let hard = mobile ? 900_000_000 : 2_400_000_000;
  let basis = mobile ? 'mobile device' : 'desktop browser';

  if (ram !== undefined) {
    // Never bet more than a fraction of physical RAM; the browser, the page and
    // the OS all need their share, and wasm cannot swap.
    const fromRam = ram * 1_000_000_000 * 0.4;
    if (fromRam < hard) {
      hard = fromRam;
      basis = `${ram}GB device memory`;
    }
  }

  return { hard, warn: hard * 0.55, basis };
}

/** Map an underlying error onto something a human can act on. */
function explain(error: unknown, job?: JobContext): { headline: string; advice?: string } {
  const message = error instanceof Error ? error.message : String(error);

  // Rust panics and aborts compiled to wasm surface as an `unreachable` trap, or
  // as an out-of-bounds/allocation error. In this app they are essentially
  // always memory exhaustion inside gifski.
  if (
    /unreachable|out of bounds|out of memory|Out of memory|allocation|Maximum call stack/i.test(
      message,
    )
  ) {
    const size = job ? ` This job needed roughly ${formatBytes(job.estimatedPeakBytes)}.` : '';
    return {
      headline: 'The encoder ran out of memory.',
      advice:
        `WebAssembly gets a fixed slice of memory, and this clip asked for more than it could` +
        ` get.${size} Try a smaller width, a lower frame rate, or a shorter trim — width helps` +
        ` most, since memory scales with width × height.`,
    };
  }

  if (/RangeError|Array buffer allocation|Invalid (typed )?array length/i.test(message)) {
    return {
      headline: 'The browser refused to allocate a buffer this large.',
      advice: 'Reduce the width or trim the clip shorter, then try again.',
    };
  }

  if (/decod|codec|not supported|Playback failed/i.test(message)) {
    return {
      headline: "This browser couldn't decode that video.",
      advice: 'MP4 (H.264) and WebM work everywhere. MOV/HEVC depends on the browser.',
    };
  }

  return { headline: message || 'Something went wrong.' };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Build the full report: what to tell the user, and what to let them copy. */
export function buildReport(
  error: unknown,
  phase: string,
  job?: JobContext,
): FailureReport {
  const { headline, advice } = explain(error, job);
  const budget = memoryBudget();
  const heapLimit = (performance as Performance & { memory?: { jsHeapSizeLimit: number } }).memory
    ?.jsHeapSizeLimit;

  const lines: string[] = [
    'VidtoGif failure report',
    `time            ${new Date().toISOString()}`,
    `failed during   ${phase}`,
    '',
    '-- error --',
    `name            ${error instanceof Error ? error.name : typeof error}`,
    `message         ${error instanceof Error ? error.message : String(error)}`,
  ];

  if (error instanceof Error && error.stack) {
    lines.push('stack', error.stack.split('\n').slice(0, 8).join('\n'));
  }

  lines.push(
    '',
    '-- device --',
    `userAgent       ${navigator.userAgent}`,
    `mobile          ${isMobile()}`,
    `deviceMemory    ${deviceMemoryGb() ?? 'unknown'}${deviceMemoryGb() ? ' GB' : ''}`,
    `cpuThreads      ${navigator.hardwareConcurrency ?? 'unknown'}`,
    `crossOriginIso  ${globalThis.crossOriginIsolated}`,
    `sharedArrayBuf  ${typeof SharedArrayBuffer !== 'undefined'}`,
    `jsHeapLimit     ${heapLimit ? formatBytes(heapLimit) : 'unknown'}`,
    `memoryBudget    ${formatBytes(budget.hard)} (${budget.basis})`,
  );

  if (job) {
    lines.push(
      '',
      '-- job --',
      `file            ${job.fileName} (${formatBytes(job.fileSize)}, ${job.fileType || 'unknown type'})`,
      `source          ${job.sourceWidth}x${job.sourceHeight}, ${job.duration.toFixed(2)}s`,
      `trim            ${job.trimStart.toFixed(2)}s - ${job.trimEnd.toFixed(2)}s`,
      `output          ${job.outputWidth}x${job.outputHeight} @ ${job.fps}fps, quality ${job.quality}`,
      `frames          ${job.frameCount}`,
      `estimatedPeak   ${formatBytes(job.estimatedPeakBytes)}`,
    );
  }

  return { headline, advice, details: lines.join('\n') };
}
