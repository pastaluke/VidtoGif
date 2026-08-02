/**
 * Pulls RGBA frames out of a video file entirely inside the browser.
 *
 * Approach: load the file into a <video> element via an object URL, seek to each
 * timestamp we want, and paint the result into a canvas at the *output* size.
 * Drawing straight to the target resolution matters — a 300-frame capture at
 * 480px wide is ~155 MB of RGBA, and at source 1080p it would be ~2.5 GB.
 *
 * This path works for any container/codec the browser can already play, which is
 * the whole point: no ffmpeg build, no server, no upload.
 */

export interface DecodeOptions {
  file: File;
  /** Trim start, in seconds. */
  start: number;
  /** Trim end, in seconds. */
  end: number;
  fps: number;
  /** Target width in px; height follows the source aspect ratio. */
  width: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface DecodedFrames {
  frames: Uint8Array[];
  width: number;
  height: number;
  /** Per-frame duration in ms, summing to the trimmed clip length. */
  frameDurations: number[];
}

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
}

export class AbortedError extends Error {
  constructor() {
    super('Conversion cancelled');
    this.name = 'AbortedError';
  }
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new AbortedError();
};

/** Resolve once the element has metadata, working around unknown-duration files. */
function loadMetadata(video: HTMLVideoElement): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(
        new Error(
          "This browser can't decode that video. Try an MP4 (H.264) or WebM file.",
        ),
      );

    video.addEventListener('error', fail, { once: true });
    video.addEventListener(
      'loadedmetadata',
      () => {
        // Some WebM/MediaRecorder files report Infinity until you seek past the
        // end, which forces the browser to scan for the real duration.
        if (video.duration === Infinity || Number.isNaN(video.duration)) {
          const onUpdate = () => {
            if (video.duration !== Infinity && !Number.isNaN(video.duration)) {
              video.removeEventListener('durationchange', onUpdate);
              video.currentTime = 0;
              resolve({
                duration: video.duration,
                width: video.videoWidth,
                height: video.videoHeight,
              });
            }
          };
          video.addEventListener('durationchange', onUpdate);
          video.currentTime = 1e101;
          return;
        }

        resolve({
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
        });
      },
      { once: true },
    );
  });
}

/** Create a detached <video> for a file and read its dimensions/duration. */
export async function probeVideo(
  file: File,
): Promise<{ info: VideoInfo; video: HTMLVideoElement; revoke: () => void }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.src = url;

  try {
    const info = await loadMetadata(video);
    return { info, video, revoke: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Seek and wait until the new frame is actually presented.
 *
 * The `seeked` event fires when the media position has moved, which is not quite
 * the same as the decoded frame being ready to paint. Where available,
 * requestVideoFrameCallback tells us precisely when a frame has been composited;
 * elsewhere a rAF tick is a good-enough proxy.
 */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(`Timed out seeking to ${time.toFixed(2)}s`)),
      15_000,
    );

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };

    video.addEventListener(
      'seeked',
      // A rAF tick after `seeked` is enough for the new frame to be paintable.
      // (requestVideoFrameCallback is *not* usable here: after a seek on a
      // paused video browsers frequently never fire it, so waiting on it just
      // stalls until a timeout.)
      () => requestAnimationFrame(() => settle()),
      { once: true },
    );

    video.addEventListener(
      'error',
      () => {
        window.clearTimeout(timeout);
        reject(new Error('Video decoding failed partway through'));
      },
      { once: true },
    );

    video.currentTime = time;
  });
}

/** Even dimensions keep scalers happy and avoid a stray half-pixel column. */
export function outputSize(
  info: VideoInfo,
  targetWidth: number,
): { width: number; height: number } {
  const width = Math.max(2, Math.round(Math.min(targetWidth, info.width) / 2) * 2);
  const scale = width / info.width;
  const height = Math.max(2, Math.round((info.height * scale) / 2) * 2);
  return { width, height };
}

export function frameCountFor(start: number, end: number, fps: number): number {
  return Math.max(2, Math.round((end - start) * fps));
}

/** Shared per-capture context, so the two strategies stay interchangeable. */
interface CaptureContext {
  video: HTMLVideoElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  clipStart: number;
  clipEnd: number;
  fps: number;
  total: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const grabFrame = (c: CaptureContext): Uint8Array => {
  c.ctx.drawImage(c.video, 0, 0, c.width, c.height);
  const { data } = c.ctx.getImageData(0, 0, c.width, c.height);
  // Hand gifski a plain Uint8Array over the same bytes (no copy). getImageData
  // hands back a fresh buffer each call, so frames never alias one another.
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

/** Frames per second implied by the median of a set of inter-frame gaps. */
function medianFps(gaps: number[]): number {
  if (gaps.length === 0) return Infinity;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  return median > 0 ? 1 / median : Infinity;
}

/**
 * Opening playback rate for capture.
 *
 * The browser presents at most one frame per display refresh, so at rate R we
 * see roughly (refresh / R) frames per second of *media* time. This assumes a
 * 60Hz display; `captureByPlayback` measures what it actually gets and slows
 * down if the machine can't keep up. Browsers get unreliable past 4x.
 */
const playbackRateFor = (fps: number): number =>
  Math.min(4, Math.max(1, Math.floor(50 / fps)));

/**
 * Primary strategy: play the clip through and keep frames as they're presented.
 *
 * Roughly 8x faster than seeking frame by frame, because one linear decode pass
 * replaces N separate seeks (each of which costs ~180ms even on a small file).
 * requestVideoFrameCallback hands us the exact `mediaTime` of every presented
 * frame, so we can sample at the requested rate and record true durations —
 * meaning a dropped frame skews timing not at all.
 */
async function captureByPlayback(
  c: CaptureContext,
): Promise<{ frames: Uint8Array[]; times: number[]; sourceFps: number }> {
  const { video, clipStart, clipEnd, fps, total, signal } = c;

  await seekTo(video, clipStart);
  throwIfAborted(signal);

  let rate = playbackRateFor(fps);
  video.playbackRate = rate;

  const frames: Uint8Array[] = [];
  const times: number[] = [];
  const interval = 1 / fps;

  // Resample against a moving target rather than a minimum gap. A gap test
  // rejects any frame arriving slightly early, which systematically halves the
  // rate whenever the source and target are close (30fps source, 25fps target).
  let nextTarget = clipStart;

  // Gaps between consecutive presented frames. The *median* of these approximates
  // the source's frame interval, which tells us the most we could ever capture.
  // (A minimum would do too, except one anomalously short gap skews it badly.)
  const presentedGaps: number[] = [];
  let lastPresented = -1;

  // Sliding window used to notice we're capturing below the requested rate.
  let windowStart = -1;
  let windowFrames = 0;

  await new Promise<void>((resolve, reject) => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      video.pause();
      resolve();
    };

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      video.pause();
      reject(error);
    };

    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (finished) return;
      if (signal?.aborted) return fail(new AbortedError());

      const t = metadata.mediaTime;

      if (t > clipEnd || frames.length >= total) return finish();

      if (lastPresented >= 0 && t > lastPresented) presentedGaps.push(t - lastPresented);
      lastPresented = t;

      if (t >= nextTarget) {
        frames.push(grabFrame(c));
        times.push(t);
        // Skip past any targets this frame already covers, so a slow patch
        // doesn't leave a backlog that captures a burst of near-identical frames.
        do {
          nextTarget += interval;
        } while (nextTarget <= t);
        c.onProgress?.(frames.length, total);

        // How much media time are we actually covering per captured frame? If
        // it's worse than asked for, the display simply can't present frames
        // fast enough at this rate — so back off. This self-tunes to the
        // machine's refresh rate instead of assuming 60Hz.
        if (windowStart < 0) {
          windowStart = t;
          windowFrames = 0;
        } else if (++windowFrames >= 6) {
          const achieved = windowFrames / (t - windowStart);
          // Don't slow down chasing frames the source doesn't have.
          const ceiling = Math.min(fps, medianFps(presentedGaps));
          if (achieved < ceiling * 0.9 && rate > 1) {
            rate = Math.max(1, rate - 1);
            video.playbackRate = rate;
          }
          windowStart = t;
          windowFrames = 0;
        }
      }

      if (video.ended) return finish();
      video.requestVideoFrameCallback(onFrame);
    };

    video.addEventListener('ended', finish, { once: true });
    video.addEventListener('error', () => fail(new Error('Playback failed')), {
      once: true,
    });

    video.requestVideoFrameCallback(onFrame);
    video.play().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
  });

  throwIfAborted(signal);
  return { frames, times, sourceFps: medianFps(presentedGaps) };
}

/**
 * Fallback strategy: seek to each timestamp and paint it.
 *
 * Much slower, but it doesn't depend on requestVideoFrameCallback or on the
 * browser presenting frames promptly during accelerated playback.
 */
async function captureBySeeking(c: CaptureContext): Promise<Uint8Array[]> {
  const { video, clipStart, clipEnd, total, signal } = c;
  const span = clipEnd - clipStart;
  const frames: Uint8Array[] = [];

  video.pause();
  video.playbackRate = 1;

  for (let i = 0; i < total; i++) {
    throwIfAborted(signal);

    // Sample at frame centres so the first and last frames aren't duplicates of
    // the trim boundaries.
    const t = clipStart + ((i + 0.5) * span) / total;
    await seekTo(video, Math.min(t, clipEnd));

    frames.push(grabFrame(c));
    c.onProgress?.(i + 1, total);
  }

  return frames;
}

export async function decodeFrames(options: DecodeOptions): Promise<DecodedFrames> {
  const { file, start, end, fps, width: targetWidth, signal, onProgress } = options;

  const { info, video, revoke } = await probeVideo(file);

  try {
    throwIfAborted(signal);

    const { width, height } = outputSize(info, targetWidth);
    const clipStart = Math.max(0, Math.min(start, info.duration));
    // Never seek to exactly `duration` — browsers often refuse to decode there.
    const clipEnd = Math.min(end, info.duration - 0.001);
    const span = Math.max(0, clipEnd - clipStart);

    if (span <= 0) {
      throw new Error('The selected range is empty. Widen the trim handles.');
    }

    const total = frameCountFor(clipStart, clipEnd, fps);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not get a 2D canvas context');

    const capture: CaptureContext = {
      video,
      ctx,
      width,
      height,
      clipStart,
      clipEnd,
      fps,
      total,
      signal,
      onProgress,
    };

    if ('requestVideoFrameCallback' in video) {
      const { frames, times, sourceFps } = await captureByPlayback(capture);

      // Judge the result against what the *source* can actually provide, not
      // against the requested rate. Asking 30fps of a 24fps clip is not a
      // failure — and re-running the slow path would only yield duplicates.
      const achievable = Math.max(2, Math.round(span * Math.min(fps, sourceFps)));

      if (frames.length >= 2 && frames.length >= achievable * 0.75) {
        return { frames, width, height, frameDurations: durationsFromTimes(times, clipEnd, fps) };
      }
    }

    const frames = await captureBySeeking(capture);

    return {
      frames,
      width,
      height,
      frameDurations: distributeDurations(span * 1000, frames.length),
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    revoke();
  }
}

/**
 * Turn the media timestamps we actually captured into per-frame durations, so
 * the GIF plays at the same speed as the source even if frames were dropped.
 */
export function durationsFromTimes(
  times: number[],
  clipEnd: number,
  fps: number,
): number[] {
  const fallback = 1000 / fps;

  return times.map((time, i) => {
    const next = i + 1 < times.length ? times[i + 1] : Math.min(clipEnd, time + fallback / 1000);
    return Math.max(1, Math.round((next - time) * 1000) || Math.round(fallback));
  });
}

/**
 * Split a total duration into integer per-frame milliseconds without drift.
 * Rounding each frame independently would accumulate error over a long clip.
 */
export function distributeDurations(totalMs: number, count: number): number[] {
  const durations: number[] = [];
  let emitted = 0;

  for (let i = 0; i < count; i++) {
    const target = Math.round(((i + 1) * totalMs) / count);
    durations.push(Math.max(1, target - emitted));
    emitted = target;
  }

  return durations;
}
