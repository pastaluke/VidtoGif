/**
 * Time expectations for the encode phase, calibrated on the user's own device.
 *
 * gifski's wasm binding exposes exactly one function — `encode` — with no
 * progress callback and no cancellation hook. The call is synchronous, so the
 * worker's event loop is blocked for its whole duration and cannot even emit a
 * heartbeat. There is therefore *no* real progress signal to display, and any
 * percentage bar would be invented.
 *
 * What can be shown honestly is elapsed time, plus how long jobs of this size
 * have actually taken on this device before. We never ship a guess from the
 * developer's machine: until this device has encoded something, there is no
 * estimate at all.
 */

const STORAGE_KEY = 'vidtogif:encode-samples:v1';
const MAX_SAMPLES = 12;

interface Sample {
  /** Total pixels encoded, in megapixels (frames × width × height). */
  mp: number;
  /** Quality rounded to the nearest 10 — cost varies sharply with it. */
  bucket: number;
  /** Seconds per megapixel. */
  spmp: number;
}

function load(): Sample[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is Sample =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as Sample).mp === 'number' &&
        typeof (s as Sample).bucket === 'number' &&
        typeof (s as Sample).spmp === 'number' &&
        Number.isFinite((s as Sample).spmp),
    );
  } catch {
    return []; // storage can be unavailable or the value corrupt; neither is fatal
  }
}

function save(samples: Sample[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(samples.slice(-MAX_SAMPLES)));
  } catch {
    /* best effort */
  }
}

export const megapixels = (frames: number, width: number, height: number): number =>
  (frames * width * height) / 1e6;

const bucketFor = (quality: number): number => Math.round(quality / 10) * 10;

/** Record how long a completed encode actually took on this device. */
export function recordEncode(mp: number, quality: number, ms: number) {
  if (!(mp > 0) || !(ms > 0)) return;
  const samples = load();
  samples.push({ mp, bucket: bucketFor(quality), spmp: ms / 1000 / mp });
  save(samples);
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/**
 * Expected seconds for a job, or undefined when this device hasn't encoded at a
 * comparable quality yet. Only samples from the same quality bucket are used:
 * measured here, quality 100 costs about four times quality 80, so mixing them
 * would produce a confidently wrong number.
 */
export function expectedSeconds(mp: number, quality: number): number | undefined {
  const samples = load();
  if (samples.length === 0) return undefined;

  const bucket = bucketFor(quality);
  const matching = samples.filter((s) => s.bucket === bucket);
  if (matching.length === 0) return undefined;

  return median(matching.map((s) => s.spmp)) * mp;
}

/** True once this device has produced any timing sample at all. */
export const hasCalibration = (): boolean => load().length > 0;

export function formatDuration(seconds: number): string {
  if (seconds < 1) return 'under a second';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * When to tell the user this is running longer than their device's own history
 * suggests. Generous on purpose: a slow phone finishing a big job is normal, and
 * crying wolf is worse than staying quiet.
 */
export function watchdogSeconds(expected: number | undefined): number {
  return expected === undefined ? 180 : Math.max(90, expected * 2.5);
}
