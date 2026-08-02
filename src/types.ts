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
  | { type: 'error'; id: number; message: string };
