/* @ds-bundle: {"format":4,"namespace":"Caravel","components":[]} */
/* Caravel motion helpers. Classic script, no imports, no network.
   Buttons (.cv-btn) release a water-drop ripple from the pointer on press:
   a filled drop and a thinner ring that follows it outward to the button's edges. */
(function () {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");

  function ripple(btn, clientX, clientY) {
    if (reduced && reduced.matches) return;
    var r = btn.getBoundingClientRect();
    var x = clientX == null ? r.width / 2 : clientX - r.left;
    var y = clientY == null ? r.height / 2 : clientY - r.top;
    var far = Math.max(
      Math.hypot(x, y), Math.hypot(r.width - x, y),
      Math.hypot(x, r.height - y), Math.hypot(r.width - x, r.height - y)
    );
    var scale = (far * 2) / 10 + 1;
    ["cv-ripple--drop", "cv-ripple--ring"].forEach(function (kind) {
      var s = document.createElement("span");
      s.className = "cv-ripple " + kind;
      s.setAttribute("aria-hidden", "true");
      s.style.setProperty("--rx", x + "px");
      s.style.setProperty("--ry", y + "px");
      s.style.setProperty("--rs", scale.toFixed(2));
      btn.appendChild(s);
      s.addEventListener("animationend", function () { s.remove(); });
    });
  }

  document.addEventListener("pointerdown", function (e) {
    var btn = e.target && e.target.closest && e.target.closest(".cv-btn");
    if (btn && !btn.disabled) ripple(btn, e.clientX, e.clientY);
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var btn = document.activeElement;
    if (btn && btn.classList && btn.classList.contains("cv-btn")) ripple(btn);
  }, true);

  window.Caravel = { ripple: ripple };
})();
