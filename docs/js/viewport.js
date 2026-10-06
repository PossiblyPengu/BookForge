// iOS 26 home-screen apps: the layout viewport can come up shorter than the
// screen (WebKit regression — fixed `bottom: 0` lands above the home
// indicator and env(safe-area-inset-bottom) reads 0). Measure the chin so
// the bottom bars can grow into it; their controls stay inside the viewport,
// the only part that takes touches.
(() => {
  if (!navigator.standalone) return; // iOS standalone only
  const root = document.documentElement;
  const topInset = () => {
    const p = document.createElement("div");
    p.style.cssText = "position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
    root.appendChild(p);
    const h = p.getBoundingClientRect().height;
    p.remove();
    return h;
  };
  let raf = 0;
  const measure = () => {
    raf = 0;
    // screen.* doesn't rotate on iOS — pick the edge that matches orientation
    const landscape = window.innerWidth > window.innerHeight;
    const screenH = landscape
      ? Math.min(window.screen.width, window.screen.height)
      : Math.max(window.screen.width, window.screen.height);
    const gap = Math.round(screenH - window.innerHeight);
    // No top inset + short viewport = the status bar reclaimed the top
    // (a different iOS 26.1 bug), not a chin at the bottom.
    const chin = gap >= 8 && gap <= 120 && topInset() > 0 ? gap : 0;
    root.style.setProperty("--chin", `${chin}px`);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
  measure();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
})();
