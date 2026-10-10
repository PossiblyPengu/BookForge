// BookMaster's pair flow ends on this origin as /?bm-link=<code>. The native
// Pageturner runs that flow in an in-app browser sheet, which can only be
// closed by a custom-scheme redirect — so hand the code to the app. An
// installed web app (standalone) still redeems its own code.
(() => {
  const m = /[?&]bm-link=([^&#]+)/.exec(location.search);
  const standalone =
    navigator.standalone || window.matchMedia?.("(display-mode: standalone)").matches;
  if (!m || standalone) return;
  // Take the code out of the address first: the web app's own link handler
  // runs from this same page and would otherwise spend the one-time code
  // before the native app can.
  history.replaceState(null, "", location.pathname + location.hash);
  location.replace(`pageturner://link?code=${m[1]}`);
})();
