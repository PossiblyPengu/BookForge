/**
 * sw-register.js
 *
 * Service worker registration and Cross-Origin-Isolated policy management.
 *
 * This file is intentionally separate from app.js so the index.html CSP can
 * avoid 'unsafe-inline' for scripts.
 */

// Disable the cross-origin-isolation service worker — it injects
// Cross-Origin-Opener-Policy: same-origin which breaks Google OAuth popups.
window.coi = { shouldRegister: () => false };

if ("serviceWorker" in navigator) {
  // Deregister stale coi-serviceworker.js registrations.
  navigator.serviceWorker.getRegistrations().then((regs) => {
    const isStale = (reg) =>
      [reg.active, reg.waiting, reg.installing].some(
        (w) => w && w.scriptURL.includes("coi-serviceworker")
      );
    const stale = regs.filter(isStale);
    if (stale.length > 0) {
      Promise.all(stale.map((reg) => reg.unregister()))
        .finally(() => window.location.reload());
      return;
    }
    // If the page somehow loaded cross-origin-isolated, flush all SWs and reload
    // so the Google OAuth popup can communicate back to this window.
    if (window.crossOriginIsolated) {
      Promise.all(regs.map((reg) => reg.unregister()))
        .finally(() => window.location.reload());
      return;
    }
    navigator.serviceWorker.register("sw.js", { scope: "./" }).then((reg) => {
      // App update notification
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            const toast = document.createElement("div");
            toast.className = "toast toast-info";
            toast.setAttribute("role", "status");
            toast.innerHTML = '<span class="toast-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span><span class="toast-msg">A new version of Pageturner is available.</span> <button class="toast-close" type="button" style="margin-left:8px;font-weight:600;color:var(--accent)">Reload</button>';
            toast.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;align-items:center;gap:8px;padding:12px 20px;border-radius:12px;background:var(--bg-card,#1d1d1b);border:1px solid var(--border,rgba(255,255,240,0.08));color:var(--text,#f0ede6);font-size:14px;box-shadow:0 8px 32px rgba(0,0,0,0.5)";
            toast.querySelector(".toast-close").addEventListener("click", () => {
              newWorker.postMessage({ type: "SKIP_WAITING" });
              toast.remove();
            });
            document.body.appendChild(toast);
          }
        });
      });
      // Check for updates periodically
      setInterval(() => reg.update(), 60000);
    }).catch(() => {});

    // Reload when new service worker takes over
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.location.reload();
    });

    // Offline indicator
    const updateOnlineStatus = () => {
      let indicator = document.getElementById("offline-indicator");
      if (!navigator.onLine) {
        if (!indicator) {
          indicator = document.createElement("div");
          indicator.id = "offline-indicator";
          indicator.setAttribute("role", "status");
          indicator.textContent = "You are offline — Pageturner works from cache.";
          indicator.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:10000;padding:6px 16px;text-align:center;font-size:13px;background:var(--warning,#fbbf24);color:#1a1a1a;font-weight:600";
          document.body.appendChild(indicator);
        }
      } else if (indicator) {
        indicator.remove();
      }
    };
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    updateOnlineStatus();
  }).catch(() => {});
}
