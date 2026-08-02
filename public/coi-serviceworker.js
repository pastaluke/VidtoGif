/**
 * Cross-origin isolation via service worker.
 *
 * gifski's multi-threaded WebAssembly build needs SharedArrayBuffer, which
 * browsers only expose to cross-origin-isolated pages — i.e. pages served with
 * `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`.
 *
 * Static hosts like GitHub Pages don't let you set response headers. The
 * workaround is to install a service worker that re-serves every same-origin
 * response with those headers attached, then reload once so the page loads under
 * the worker's control.
 *
 * Without this the app still works — gifski-wasm falls back to its
 * single-threaded build — it's just noticeably slower.
 *
 * Based on the approach popularised by Guido Zuidhof's coi-serviceworker (MIT).
 */

if (typeof window === 'undefined') {
  // ----- service worker side -----

  self.addEventListener('install', () => self.skipWaiting());

  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'deregister') {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    }
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;

    // Range requests served from the HTTP cache can't be reconstructed here.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

    event.respondWith(
      fetch(request)
        .then((response) => {
          // Opaque responses have no readable body or headers to copy.
          if (response.status === 0) return response;

          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        .catch((error) => {
          console.error('[coi] fetch failed', error);
          throw error;
        }),
    );
  });
} else {
  // ----- page side -----

  // `currentScript` is only valid while this script is being evaluated.
  const scriptUrl = window.document.currentScript.src;

  // Guard against a reload loop if, for any reason, installing the worker never
  // results in an isolated page (blocked worker, stripped headers, extension...).
  const RELOAD_FLAG = 'coi-reload-attempted';

  const session = {
    get(key) {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null; // storage can be unavailable in hardened privacy modes
      }
    },
    set(key, value) {
      try {
        window.sessionStorage.setItem(key, value);
      } catch {
        /* best effort */
      }
    },
    clear(key) {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* best effort */
      }
    },
  };

  (async () => {
    // Already isolated (the SW is live, or a real server sent the headers).
    if (window.crossOriginIsolated) {
      session.clear(RELOAD_FLAG);
      return;
    }

    if (!window.isSecureContext) {
      console.warn('[coi] Not a secure context; multi-threaded encoding unavailable.');
      return;
    }

    if (!navigator.serviceWorker) {
      console.warn('[coi] No service worker support; using single-threaded encoding.');
      return;
    }

    if (session.get(RELOAD_FLAG)) {
      console.warn('[coi] Isolation did not take effect; using single-threaded encoding.');
      return;
    }

    try {
      // `register` resolves with undefined when a policy or tooling blocks it.
      const registration = await navigator.serviceWorker.register(scriptUrl);
      if (!registration) return;

      await navigator.serviceWorker.ready;

      // Claiming the page doesn't re-issue the document request, so the current
      // response still has no COOP/COEP. One reload under the worker fixes that.
      session.set(RELOAD_FLAG, '1');
      window.location.reload();
    } catch (error) {
      console.warn('[coi] Registration failed; using single-threaded encoding.', error);
    }
  })();
}
