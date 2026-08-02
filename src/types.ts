export interface EncodeRequest {
  id: number;
  frames: Uint8Array[];
  width: number;
  height: number;
  /** Per-frame display duration in milliseconds. */
  frameDurations: number[];
  /** gifski quality, 1-100. */
  quality: number;
  /** 0 = loop forever, -1 = play once, n = repeat n times. */
  repeat: number;
}

export type WorkerResponse =
  | { type: 'done'; id: number; gif: Uint8Array }
  // Errors cross the worker boundary as plain data, so carry the parts that
  // matter for diagnosis. A wasm panic arrives as RuntimeError("unreachable"),
  // and losing the name would hide that it came from inside gifski.
  | { type: 'error'; id: number; name: string; message: string; stack?: string };
