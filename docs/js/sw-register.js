/**
 * sw-register.js — service worker registration, update prompt, offline banner.
 *
 * Kept separate from app.js (and out of a <script> block) so index.html's CSP
 * never needs 'unsafe-inline' for scripts. It runs before the module graph
 * loads, so it uses no imports.
 */

if ("serviceWorker" in navigator) {
  // toast-sticky: util.js's toast() clears transient toasts, not these
  const banner = (msg, actionLabel, onAction) => {
    const el = document.createElement("div");
    el.className = "toast toast-sticky";
    el.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "toast-msg";
    text.textContent = msg;
    el.appendChild(text);
    if (actionLabel) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = actionLabel;
      btn.addEventListener("click", () => { el.remove(); onAction(); });
      el.appendChild(btn);
    }
    document.body.appendChild(el);
    return el;
  };

  // A new worker has installed alongside the running one. Don't swap it in
  // underneath someone who is mid-chapter — offer, and reload on their say-so.
  let reloading = false;
  const offerUpdate = (worker) => {
    if (document.querySelector(".toast-update")) return;
    const el = banner("A new version of Pageturner is available.", "Reload", () => {
      reloading = true;
      worker.postMessage({ type: "SKIP_WAITING" });
    });
    el.classList.add("toast-update");
  };

  navigator.serviceWorker.register("sw.js", { scope: "./" }).then((reg) => {
    // already waiting from a previous visit
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        // `controller` is null on a first install: that worker is the app
        // arriving, not an update to announce.
        if (worker.state === "installed" && navigator.serviceWorker.controller)
          offerUpdate(worker);
      });
    });
    // catch deploys during a long session
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });
  }).catch(() => {});

  // Only reload for a worker the user accepted. The first install also fires
  // controllerchange (the worker calls clients.claim()), and reloading there
  // made every first visit flash and start over.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) window.location.reload();
  });

  // ---------- offline banner ----------
  let offlineEl = null;
  const updateOnlineStatus = () => {
    if (navigator.onLine) {
      offlineEl?.remove();
      offlineEl = null;
      return;
    }
    if (offlineEl) return;
    offlineEl = document.createElement("div");
    offlineEl.id = "offline-indicator";
    offlineEl.setAttribute("role", "status");
    offlineEl.textContent = "Offline — your library still works.";
    document.body.appendChild(offlineEl);
  };
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  updateOnlineStatus();
}
