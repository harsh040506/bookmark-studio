// The share box on the public pages. Without JavaScript the link field and the platform links
// still work; this adds the system share sheet and a copy button where the browser has them.
(function () {
  var root = document.querySelector("[data-share-root]");
  if (!root) return;
  var url = root.getAttribute("data-url");
  var title = root.getAttribute("data-title");
  var text = root.getAttribute("data-text");
  var status = root.querySelector("[data-share-status]");
  var shareButton = root.querySelector("[data-share]");
  var copyButton = root.querySelector("[data-copy]");
  var field = root.querySelector("input");

  function say(message) {
    // Cleared first so the same message is announced again on a second click.
    status.textContent = "";
    setTimeout(function () {
      status.textContent = message;
    }, 50);
  }

  if (field) {
    field.addEventListener("focus", function () {
      field.select();
    });
  }

  if (navigator.share && shareButton) {
    shareButton.hidden = false;
    shareButton.addEventListener("click", function () {
      navigator.share({ title: title, text: text, url: url }).catch(function (error) {
        if (error && error.name === "AbortError") return;
        say("Your browser could not open its share menu. Copy the link above instead.");
      });
    });
  }

  if (navigator.clipboard && window.isSecureContext && copyButton) {
    copyButton.hidden = false;
    copyButton.addEventListener("click", function () {
      navigator.clipboard.writeText(url).then(
        function () {
          say("Link copied.");
        },
        function () {
          if (field) field.select();
          say("Your browser blocked copying. The link is selected above: press Ctrl C or ⌘ C.");
        },
      );
    });
  }
})();
