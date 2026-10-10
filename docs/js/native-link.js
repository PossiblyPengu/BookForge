// BookMaster's pair flow ends on this origin as /?bm-link=<code>. The native
// Pageturner runs that flow in an in-app browser sheet, which can only be
// closed by a custom-scheme redirect — so hand the code to the app. An
// installed web app (standalone) still redeems its own code.
(() => {
  const m = /[?&]bm-link=([^&#]+)/.exec(location.search);
  const standalone =
    navigator.standalone || window.matchMedia?.("(display-mode: standalone)").matches;
  if (m && !standalone) location.replace(`pageturner://link?code=${m[1]}`);
})();
