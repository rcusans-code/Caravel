/* @ds-bundle: {"format":4,"namespace":"Caravel","components":[]} */
/* Caravel motion helpers. Classic script, no imports, no network.
   Exposes Caravel.ripple, Caravel.flash (value changed), Caravel.stamp (replay a seal), Caravel.live (set a live indicator).
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

  /* Value flash: call when a figure's value changes. dir: "up" | "down" | undefined (gold). */
  function flash(el, dir) {
    if (!el || (reduced && reduced.matches)) return;
    el.classList.remove("cv-flash", "cv-flash--up", "cv-flash--down");
    void el.offsetWidth;
    el.classList.add("cv-flash");
    if (dir === "up" || dir === "down") el.classList.add("cv-flash--" + dir);
  }

  /* Seal stamp: replay the press on an existing .cv-stamp. */
  function stamp(el) {
    if (!el || (reduced && reduced.matches)) return;
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
  }

  /* Live indicator: set "on" | "stale" | "off" and the visible word with it. */
  function live(el, state, word) {
    if (!el) return;
    el.classList.remove("cv-live--on", "cv-live--stale", "cv-live--off");
    el.classList.add("cv-live--" + state);
    var w = el.querySelector(".cv-live__word");
    if (w && word) w.textContent = word;
  }

  window.Caravel = { ripple: ripple, flash: flash, stamp: stamp, live: live };
})();
