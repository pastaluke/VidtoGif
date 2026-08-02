import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (https://user.github.io/VidtoGif/) as well as at a domain root.
  base: './',

  // gifski-wasm ships raw .wasm + wasm-bindgen glue. Pre-bundling mangles the
  // asset URLs, so leave it to Rollup. See gifski-wasm README "Known Issues".
  optimizeDeps: {
    exclude: ['gifski-wasm'],
  },

  worker: {
    // wasm-bindgen-rayon spawns its thread pool with `new Worker(url, {type:'module'})`
    format: 'es',
  },

  server: {
    // SharedArrayBuffer (and therefore multi-threaded gifski) requires the page
    // to be cross-origin isolated. In production a service worker supplies these
    // headers; the dev server sets them directly.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  build: {
    target: 'es2022',
  },
});
