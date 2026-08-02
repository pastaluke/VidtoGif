/**
 * Runs gifski (compiled to WebAssembly) off the main thread.
 *
 * `gifski-wasm/multi-thread` picks the rayon-parallel build when the worker has
 * SharedArrayBuffer available, and silently falls back to the single-threaded
 * build when it doesn't — so this file works with or without cross-origin
 * isolation. It just runs a lot faster with it.
 */
import encode from 'gifski-wasm/multi-thread';
import type { EncodeRequest, WorkerResponse } from './types';

self.addEventListener('message', async (event: MessageEvent<EncodeRequest>) => {
  const { id, frames, width, height, frameDurations, quality, repeat } = event.data;

  const post = (message: WorkerResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(message, transfer ?? []);

  try {
    const gif = await encode({
      frames,
      width,
      height,
      frameDurations,
      quality,
      repeat,
    });

    // `gif` is a view over the wasm heap; copy it out before transferring so we
    // hand over a standalone buffer rather than a slice of linear memory.
    const bytes = new Uint8Array(gif.length);
    bytes.set(gif);

    post({ type: 'done', id, gif: bytes }, [bytes.buffer]);
  } catch (error) {
    post({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
