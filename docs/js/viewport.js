// iOS 26 home-screen apps lay out against a viewport that can be shorter than
// the screen (a WebKit regression — fixed `bottom: 0` lands above the home
// indicator and env(safe-area-inset-bottom) reads 0). Measure the chin and
// export it as --chin so the bottom bars can grow into it; their controls
// stay inside the viewport, the only part that takes touches.
(() => {
  // Installed standalone in either reporting mode — the display-mode media
  // query covers builds where navigator.standalone wasn't set at install.
  const standalone =
    navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  if (!standalone) return;

  const root = document.documentElement;
  let raf = 0;
  const measure = () => {
    raf = 0;
    // screen.* doesn't rotate on iOS — pick the edge that matches orientation.
    const landscape = window.innerWidth > window.innerHeight;
    const screenH = landscape
      ? Math.min(window.screen.width, window.screen.height)
      : Math.max(window.screen.width, window.screen.height);
    const gap = Math.round(screenH - window.innerHeight);
    // A short viewport can mean a chin at the bottom or the status bar
    // reclaimed the top (a different iOS 26.1 bug). The visual viewport's
    // offset says which — don't probe env() insets, they lie on iOS 26.
    const topGap = Math.round(window.visualViewport?.offsetTop || 0);
    const chin =
      gap >= 8 && gap <= 160 ? Math.max(0, Math.min(gap - topGap, 160)) : 0;
    root.style.setProperty("--chin", `${chin}px`);
    root.dataset.standaloneGap = `${gap}`;

    // The status-bar style is baked into the icon at Add to Home Screen, so
    // both shapes still ship in the wild:
    //   "default"           — the webview parks below the OS strip; no inset
    //                         needed whatever env() claims
    //   "black-translucent" — full-bleed, the strip's scrim overlaps the page;
    //                         env() should carry the inset but reports 0 on
    //                         iOS 26, which is how the wordmark slid under the
    //                         scrim. Floor it so content clears the veil.
    // Probe env() rather than read it: matchMedia can't see insets.
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;top:0;left:0;visibility:hidden;height:env(safe-area-inset-top,0px)";
    root.appendChild(probe);
    const envTop = probe.getBoundingClientRect().height;
    probe.remove();
    let safeTop = envTop;
    if (gap >= 8 && topGap >= 8) safeTop = 0;
    else if (!landscape && envTop < 8 && gap < 8) safeTop = 54;
    if (safeTop === envTop) root.style.removeProperty("--safe-top");
    else root.style.setProperty("--safe-top", `${safeTop}px`);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };

  measure();
  // The standalone viewport isn't settled at <head> time — the shrink lands
  // during first layout, so measure again once the page is up and a moment
  // later, not just on resizes that may never come.
  if (document.readyState === "complete") measure();
  else window.addEventListener("load", measure);
  setTimeout(measure, 300);
  setTimeout(measure, 1500);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.addEventListener("pageshow", schedule);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule();
  });
  window.visualViewport?.addEventListener("resize", schedule);
})();
