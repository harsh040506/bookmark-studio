// Applies the saved theme before the first paint, so a dark-mode user never sees a white flash.
// A separate file (not inline) so the extension's content security policy needs no 'unsafe-inline'.
// Reads the same "bs:settings" key that src/hooks/useTheme.ts writes.
(function () {
  var theme = "light";
  try {
    var saved = JSON.parse(localStorage.getItem("bs:settings") || "{}").theme || "system";
    theme = saved === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : saved;
  } catch (e) {
    try { theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (e2) { /* light */ }
  }
  var root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
})();
