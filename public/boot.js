// Plain (non-module) script that runs even when the app's modules can't. If the app hasn't
// started within a few seconds, or a script error stops it, show what happened and a
// Reload button instead of a blank page.
(function () {
  var shown = false;
  function show(reason) {
    if (shown || window.__mealPlanner) return;
    shown = true;
    var box = document.getElementById("view-calendar");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div class="card" data-testid="boot-error"><h2>The planner didn’t start</h2>' +
      '<p>This usually happens right after an update while the phone still has older files saved. Reloading fixes it. Your data is safe on this device.</p>' +
      '<p><button class="btn primary" type="button" id="boot-reload">Reload</button></p>' +
      '<p class="small muted" id="boot-reason"></p></div>';
    document.getElementById("boot-reason").textContent = reason ? "Details: " + reason : "";
    document.getElementById("boot-reload").addEventListener("click", function () {
      location.replace(location.pathname + "?r=" + Date.now() + location.hash);
    });
  }
  window.addEventListener("error", function (e) { setTimeout(function () { show(e && e.message); }, 1500); });
  window.addEventListener("load", function () { setTimeout(function () { show(""); }, 6000); });
})();
