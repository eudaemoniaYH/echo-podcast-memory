(() => {
  const isServiceWorker = typeof Window === "undefined";

  // This file is also loaded by the page so registration stays compatible
  // with the site's script-src 'self' content security policy.
  if (!isServiceWorker) {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
      });
    }
    return;
  }

  const CACHE_NAME = "echo-shell-v7";
  const SHELL_FILES = [
    "/",
    "/index.html",
    "/styles.css?v=7",
    "/app.js?v=7",
    "/manifest.webmanifest",
    "/icons/echo.svg",
    "/icons/echo-180.png",
    "/icons/echo-192.png",
    "/icons/echo-512.png"
  ];
  const STATIC_PATHS = new Set(
    SHELL_FILES
      .filter((path) => path !== "/" && path !== "/index.html")
      .map((path) => new URL(path, self.location.origin).pathname)
  );

  self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
    self.skipWaiting();
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches.keys()
        .then((names) => Promise.all(
          names.filter((name) => name.startsWith("echo-shell-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        ))
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy)));
            }
            return response;
          })
          .catch(async () => (await caches.match("/index.html")) || caches.match("/"))
      );
      return;
    }

    if (!STATIC_PATHS.has(url.pathname)) return;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match(url.pathname)) || Response.error())
    );
  });
})();
