// CiteSeek "Shoot to index": flick a paper ball into the hoop to upload it.
// Self-contained: window.Court.open(file, origin, { onScore, onSkip, onCancel }).
"use strict";

(function () {
  const G = 2600;          // gravity, px/s²
  const R = 24;            // ball radius
  const RIM = 46;          // half the rim width (inner opening = 92px)
  const MAX_SPEED = 3600;  // clamp for wild flicks
  const E_RIM = 0.55, E_BOARD = 0.6, E_FLOOR = 0.5;
  const PULL_MAX = 170;    // slingshot: furthest you can pull back, px
  const POWER = 16;        // slingshot: launch speed per px of pull

  const MODE_KEY = "cs.throwMode";
  const HINTS = {
    flick: "Grab the paper, swing toward the hoop and let go. Your flick sets the arc.",
    sling: "Pull the paper back, away from the hoop. The dotted line shows the shot. Let go to launch.",
  };
  const getMode = () => { try { return localStorage.getItem(MODE_KEY) === "sling" ? "sling" : "flick"; } catch { return "flick"; } };
  const saveMode = (m) => { try { localStorage.setItem(MODE_KEY, m); } catch {} };

  const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const BALL_SVG = (ext) => `
    <svg viewBox="0 0 56 56" aria-hidden="true">
      <defs>
        <radialGradient id="ballShade" cx="38%" cy="32%" r="70%">
          <stop offset="0" stop-color="#fffdf8"/><stop offset=".65" stop-color="#efe6d3"/><stop offset="1" stop-color="#d6c7a8"/>
        </radialGradient>
      </defs>
      <path d="M28 3l7 4 8-1 4 7 6 5-1 8 3 7-5 6-1 8-7 3-5 5-8-2-7 3-5-6-8-2-1-8-5-5 3-7-2-8 6-4 3-7 8 0z"
            fill="url(#ballShade)" stroke="#b9a988" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M11 20l9 6 7-9 8 7 10-4M9 33l10-2 6 8 9-6 11 4M20 26l-1 6M35 24l-1 10M27 17l-1 22"
            fill="none" stroke="#c8b897" stroke-width="1.1" stroke-linecap="round"/>
      <rect x="14" y="22" width="28" height="12" rx="3" fill="#2e5a43"/>
      <text x="28" y="31" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="8" font-weight="600" fill="#fbf8f2">${ext}</text>
    </svg>`;

  // Hoop SVG is 200×230; rim centre sits at (100, 120) in its coordinates.
  const HOOP_BACK = `
    <svg viewBox="0 0 200 230" aria-hidden="true">
      <rect x="152" y="8" width="12" height="150" rx="3" fill="#fbf8f2" stroke="#2e5a43" stroke-width="3"/>
      <rect x="164" y="60" width="26" height="8" rx="2" fill="#2e5a43"/>
      <rect x="154" y="78" width="8" height="40" rx="1" fill="none" stroke="#a8683a" stroke-width="2"/>
      <path d="M54 120a46 7 0 0 1 92 0" fill="none" stroke="#8a5530" stroke-width="5" stroke-linecap="round"/>
      <g class="net net-back" stroke="#cdbf9f" stroke-width="1.6" fill="none" stroke-linecap="round">
        <path d="M64 124l14 64M86 126l6 66M114 126l-6 66M136 124l-14 64"/>
      </g>
    </svg>`;
  const HOOP_FRONT = `
    <svg viewBox="0 0 200 230" aria-hidden="true">
      <g class="net net-front" stroke="#efe6d3" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M54 121l18 70h56l18-70"/>
        <path d="M54 121l38 70M146 121l-38 70M72 121l36 70M128 121l-36 70M58 140h84M64 162h72M70 182h60"/>
      </g>
      <path d="M54 120a46 7 0 0 0 92 0" fill="none" stroke="#a8683a" stroke-width="6" stroke-linecap="round"/>
    </svg>`;

  let active = null;

  function open(file, origin, handlers) {
    if (reduceMotion()) return false;
    close();

    const ext = (file.name.split(".").pop() || "PDF").slice(0, 3).toUpperCase();
    const root = document.createElement("div");
    root.className = "court";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Upload a paper: throw it into the hoop, or press Enter to upload straight away");
    root.innerHTML = `
      <div class="court-floor"></div>
      <div class="court-copy">
        <div class="court-kicker">Shoot to index</div>
        <div class="court-title">Toss <em>${escape(file.name)}</em> into the hoop</div>
        <div class="court-hint"></div>
        <div class="court-mode" role="radiogroup" aria-label="Throw style">
          <button role="radio" data-mode="flick">Flick it</button>
          <button role="radio" data-mode="sling">Slingshot</button>
        </div>
      </div>
      <svg class="court-guide" aria-hidden="true"><path fill="none"/></svg>
      <svg class="court-aim" aria-hidden="true">
        <circle class="sling-post" r="7"/>
        <path class="sling-band"/>
        <g class="aim-dots"></g>
      </svg>
      <div class="hoop hoop-back">${HOOP_BACK}</div>
      <div class="ball" role="button" aria-label="Paper ball. Drag and release to throw.">${BALL_SVG(escape(ext))}</div>
      <div class="hoop hoop-front">${HOOP_FRONT}</div>
      <div class="court-score" aria-live="polite"></div>
      <div class="court-actions">
        <span class="court-tries"></span>
        <span class="court-keys" aria-hidden="true">Enter to upload · Esc to cancel</span>
        <button class="court-skip">Skip, just index it</button>
        <button class="court-cancel" aria-label="Cancel">Cancel</button>
      </div>`;
    document.body.appendChild(root);

    const $ = (s) => root.querySelector(s);
    const ball = $(".ball"), back = $(".hoop-back"), front = $(".hoop-front");
    const guide = $(".court-guide"), score = $(".court-score"), tries = $(".court-tries"), skip = $(".court-skip");
    const aim = $(".court-aim"), band = $(".sling-band"), post = $(".sling-post"), dots = $(".aim-dots"), hint = $(".court-hint");
    let throwMode = getMode();

    function applyMode(m) {
      throwMode = m;
      root.dataset.mode = m;
      hint.textContent = HINTS[m];
      root.querySelectorAll(".court-mode button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === m)));
      drawGuide();
    }
    root.querySelector(".court-mode").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mode]");
      if (!b || st.mode === "drag" || st.mode === "scored") return;
      saveMode(b.dataset.mode);
      applyMode(b.dataset.mode);
      if (st.mode === "idle") reset();
    });

    const st = {
      W: 0, H: 0, hx: 0, hy: 0, floor: 0,
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, spin: 0,
      home: { x: 0, y: 0 },
      mode: "idle", // idle | drag | fly | scored
      samples: [], grab: { dx: 0, dy: 0 },
      touchedRim: false, restTime: 0, attempts: 0, raf: 0, last: 0, t0: performance.now(),
    };

    function layout() {
      st.W = window.innerWidth;
      st.H = window.innerHeight;
      st.floor = st.H - 34;
      st.hx = Math.max(st.W * 0.76, Math.min(st.W - 130, st.W * 0.5 + 220));
      if (st.W < 640) st.hx = st.W - 110;
      st.hy = Math.max(170, st.H * 0.34);
      for (const el of [back, front]) el.style.transform = `translate(${st.hx - 100}px, ${st.hy - 120}px)`;
      const minGap = Math.min(380, st.W * 0.45);
      const ox = origin?.x ?? st.W * 0.22, oy = origin?.y ?? st.H * 0.7;
      st.home = {
        x: clamp(Math.min(ox, st.hx - minGap), R + 16, st.W - R - 16),
        y: clamp(oy, st.hy + 60, st.floor - R - 40),
      };
      drawGuide();
    }

    function drawGuide() {
      const { x, y } = st.home;
      const cx = (x + st.hx) / 2, cy = Math.min(y, st.hy) - Math.max(140, (st.hx - x) * 0.45);
      guide.setAttribute("width", st.W);
      guide.setAttribute("height", st.H);
      // Flick: the arc to aim for. Slingshot: an arrow showing "pull back this way".
      guide.querySelector("path").setAttribute("d", throwMode === "sling"
        ? `M${x - R - 8} ${y + 10} L${x - R - 78} ${y + 58} M${x - R - 78} ${y + 58} l4 -16 M${x - R - 78} ${y + 58} l16 -2`
        : `M${x} ${y - R - 6} Q${cx} ${cy} ${st.hx} ${st.hy - 18}`);
      aim.setAttribute("width", st.W);
      aim.setAttribute("height", st.H);
      post.setAttribute("cx", x);
      post.setAttribute("cy", y);
    }

    /** Slingshot preview: dots along the path the ball would take (ignoring the hoop). */
    function drawAim(ax, ay, bx, by) {
      band.setAttribute("d", `M${ax} ${ay - 7} L${bx} ${by} L${ax} ${ay + 7}`);
      let x = bx, y = by, vx = (ax - bx) * POWER, vy = (ay - by) * POWER;
      const pts = [];
      for (let i = 0; i < 40; i++) {
        for (let k = 0; k < 4; k++) { vy += G * 0.01; vx *= 1 - 0.0008; x += vx * 0.01; y += vy * 0.01; }
        if (y > st.floor || x > st.W + 20 || x < -20) break;
        pts.push([x, y]);
      }
      dots.innerHTML = pts.map(([px, py], i) =>
        `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${Math.max(1.6, 4 - i * 0.07).toFixed(2)}" opacity="${Math.max(0.12, 0.85 - i * 0.022).toFixed(2)}"/>`).join("");
    }
    function clearAim() { dots.innerHTML = ""; band.setAttribute("d", ""); }

    function place() {
      ball.style.transform = `translate(${st.x - R}px, ${st.y - R}px) rotate(${st.angle}deg)`;
    }

    function reset() {
      st.mode = "idle";
      st.x = st.home.x; st.y = st.home.y; st.vx = st.vy = 0;
      st.touchedRim = false; st.restTime = 0;
      ball.classList.remove("gone");
      ball.classList.add("spawn");
      setTimeout(() => ball.classList.remove("spawn"), 350);
      place();
    }

    // --- Input ---
    ball.addEventListener("pointerdown", (e) => {
      if (st.mode === "scored" || st.mode === "missed") return;
      e.preventDefault();
      ball.setPointerCapture(e.pointerId);
      if (throwMode === "sling") {
        // Anchor at the resting spot; the ball stretches back from there.
        st.anchor = st.mode === "idle" ? { x: st.home.x, y: st.home.y } : { x: st.x, y: st.y };
        st.grab = { dx: e.clientX - st.x, dy: e.clientY - st.y };
        st.vx = st.vy = 0;
      } else {
        st.grab = { dx: e.clientX - st.x, dy: e.clientY - st.y };
        st.samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      }
      st.mode = "drag";
      root.classList.add("aiming");
      ball.classList.add("held");
    });
    ball.addEventListener("pointermove", (e) => {
      if (st.mode !== "drag") return;
      if (throwMode === "sling") {
        let dx = e.clientX - st.grab.dx - st.anchor.x, dy = e.clientY - st.grab.dy - st.anchor.y;
        const d = Math.hypot(dx, dy);
        if (d > PULL_MAX) { dx *= PULL_MAX / d; dy *= PULL_MAX / d; }
        st.x = st.anchor.x + dx;
        st.y = Math.min(st.anchor.y + dy, st.floor - R);
        st.angle = Math.atan2(dy, dx) * 57.3 * 0.15;
        drawAim(st.anchor.x, st.anchor.y, st.x, st.y);
        root.classList.toggle("taut", d > 14);
      } else {
        const now = performance.now();
        st.x = e.clientX - st.grab.dx;
        st.y = Math.min(e.clientY - st.grab.dy, st.floor - R);
        st.samples.push({ x: e.clientX, y: e.clientY, t: now });
        while (st.samples.length > 2 && now - st.samples[0].t > 90) st.samples.shift();
      }
      place();
    });

    function launch(vx, vy) {
      const sp = Math.hypot(vx, vy);
      if (sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; }
      st.vx = vx; st.vy = vy;
      st.spin = vx * 0.25;
      st.mode = "fly";
      st.attempts++;
      tries.textContent = `Shot ${st.attempts}`;
      if (st.attempts >= 3) skip.classList.add("nudge");
    }

    const release = () => {
      if (st.mode !== "drag") return;
      ball.classList.remove("held");
      root.classList.remove("taut");
      if (throwMode === "sling") {
        clearAim();
        const dx = st.anchor.x - st.x, dy = st.anchor.y - st.y;
        if (Math.hypot(dx, dy) < 14) {
          // Barely pulled: treat as a cancel and snap back.
          root.classList.remove("aiming");
          return reset();
        }
        thwip();
        return launch(dx * POWER, dy * POWER);
      }
      const now = performance.now();
      const s = st.samples.filter((p) => now - p.t < 110);
      let vx = 0, vy = 0;
      if (s.length >= 2) {
        const a = s[0], b = s[s.length - 1];
        const dt = Math.max((b.t - a.t) / 1000, 0.012);
        vx = (b.x - a.x) / dt;
        vy = (b.y - a.y) / dt;
      }
      launch(vx, vy);
    };
    ball.addEventListener("pointerup", release);
    ball.addEventListener("pointercancel", release);

    // --- Physics ---
    function collidePoint(px, py, pr, e) {
      const dx = st.x - px, dy = st.y - py;
      const d = Math.hypot(dx, dy);
      const min = R + pr;
      if (d >= min || d === 0) return false;
      const nx = dx / d, ny = dy / d;
      st.x = px + nx * min;
      st.y = py + ny * min;
      const vn = st.vx * nx + st.vy * ny;
      if (vn < 0) {
        st.vx -= (1 + e) * vn * nx;
        st.vy -= (1 + e) * vn * ny;
        st.spin = -st.spin * 0.6 + st.vx * 0.1;
      }
      return true;
    }

    function step(dt) {
      const prevY = st.y;
      st.vy += G * dt;
      st.vx *= 1 - 0.08 * dt;
      st.x += st.vx * dt;
      st.y += st.vy * dt;
      st.angle += st.spin * dt;

      // Rim edges
      if (collidePoint(st.hx - RIM, st.hy, 4, E_RIM) | collidePoint(st.hx + RIM, st.hy, 4, E_RIM)) {
        if (!st.touchedRim) clank();
        st.touchedRim = true;
      }
      // Backboard (vertical segment)
      const bx = st.hx + RIM + 12;
      const by = clamp(st.y, st.hy - 112, st.hy + 38);
      if (collidePoint(bx, by, 6, E_BOARD)) thud();

      // Score: centre drops through the rim plane between the edges, moving down
      if (st.mode === "fly" && st.vy > 0 && prevY < st.hy && st.y >= st.hy &&
          st.x > st.hx - RIM + R * 0.35 && st.x < st.hx + RIM - R * 0.35) {
        scored();
      }

      // Floor
      if (st.y > st.floor - R) {
        st.y = st.floor - R;
        if (st.vy > 0) st.vy = -st.vy * E_FLOOR;
        st.vx *= 0.82;
        st.spin = st.vx * 0.4;
        if (Math.abs(st.vy) < 60) st.vy = 0;
      }
    }

    function tick(now) {
      const dt = Math.min((now - st.last) / 1000, 1 / 30);
      st.last = now;
      if (st.mode === "fly" || st.mode === "scored") {
        const sub = 4;
        for (let i = 0; i < sub; i++) step(dt / sub);
        place();

        if (st.mode === "scored") {
          if (st.y > st.hy + 90) ball.classList.add("gone");
        } else {
          const out = st.x < -80 || st.x > st.W + 80 || st.y > st.H + 100;
          const resting = st.y >= st.floor - R - 0.5 && Math.abs(st.vx) < 25;
          st.restTime = resting ? st.restTime + dt : 0;
          if (out || st.restTime > 0.35) missed();
        }
      } else if (st.mode === "idle") {
        // Gentle bob so it reads as "pick me up".
        st.y = st.home.y + Math.sin((now - st.t0) / 380) * 4;
        place();
      }
      st.raf = requestAnimationFrame(tick);
    }

    let missTimer = 0;
    function missed() {
      st.mode = "missed";
      root.classList.remove("aiming");
      flash(["So close.", "Off the mark.", "Brick!", "Again!"][Math.min(st.attempts - 1, 3)], "miss");
      ball.classList.add("gone");
      clearTimeout(missTimer);
      missTimer = setTimeout(reset, 450);
    }

    function scored() {
      st.mode = "scored";
      st.vx *= 0.25;
      st.vy = Math.min(st.vy, 500);
      root.classList.add("scored");
      front.classList.add("swish");
      back.classList.add("swish");
      const word = !st.touchedRim ? "Swish!" : "Bucket!";
      const sub = st.attempts === 1 ? "First try. Indexing your paper…" : `Shot ${st.attempts}. Indexing your paper…`;
      flash(`${word}<small>${sub}</small>`, "hit");
      burst(st.hx, st.hy);
      setTimeout(() => { finish(); handlers.onScore?.(); }, 1100);
    }

    function flash(html, kind) {
      score.className = `court-score show ${kind}`;
      score.innerHTML = html;
      clearTimeout(flash.t);
      if (kind === "miss") flash.t = setTimeout(() => score.classList.remove("show"), 900);
    }

    function burst(x, y) {
      const colors = ["#2e5a43", "#7f9b72", "#a8683a", "#d9a877", "#e8dfcc"];
      for (let i = 0; i < 22; i++) {
        const p = document.createElement("i");
        p.className = "spark";
        p.style.left = `${x}px`;
        p.style.top = `${y}px`;
        p.style.background = colors[i % colors.length];
        root.appendChild(p);
        const ang = Math.random() * Math.PI * 2, dist = 50 + Math.random() * 90;
        p.animate(
          [
            { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
            { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist - 30}px)) scale(.4) rotate(${ang * 90}deg)`, opacity: 0 },
          ],
          { duration: 700 + Math.random() * 300, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" }
        );
      }
    }

    // Tiny synthesized sounds (no audio files). Silent if audio is unavailable.
    let audio;
    function tone(freq, dur, type = "triangle", vol = 0.06) {
      try {
        audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = type; o.frequency.value = freq;
        g.gain.setValueAtTime(vol, audio.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
        o.connect(g).connect(audio.destination);
        o.start(); o.stop(audio.currentTime + dur);
      } catch {}
    }
    let lastClank = 0, lastThud = 0;
    function clank() { const n = performance.now(); if (n - lastClank > 120) { lastClank = n; tone(520, 0.12, "square", 0.025); } }
    function thwip() { tone(330, 0.09, "triangle", 0.05); setTimeout(() => tone(660, 0.07, "triangle", 0.03), 40); }
    function thud() { const n = performance.now(); if (n - lastThud > 150) { lastThud = n; tone(140, 0.1, "sine", 0.07); } }

    // --- Lifecycle ---
    function finish() {
      cancelAnimationFrame(st.raf);
      clearTimeout(missTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      root.classList.add("leaving");
      setTimeout(() => root.remove(), 250);
      active = null;
    }
    function onResize() { layout(); if (st.mode === "idle") reset(); }
    function onKey(e) {
      if (e.key === "Escape") { finish(); handlers.onCancel?.(); }
      if (e.key === "Enter" && st.mode !== "scored") { finish(); handlers.onSkip?.(); }
    }

    skip.addEventListener("click", () => { finish(); handlers.onSkip?.(); });
    $(".court-cancel").addEventListener("click", () => { finish(); handlers.onCancel?.(); });
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);

    applyMode(throwMode);
    layout();
    // Start the ball where the file was dropped, then settle it at home.
    st.x = clamp(origin?.x ?? st.home.x, R, st.W - R);
    st.y = clamp(origin?.y ?? st.home.y, R, st.floor - R);
    place();
    requestAnimationFrame(() => {
      ball.style.transition = "transform .45s cubic-bezier(.3,1.4,.5,1)";
      st.x = st.home.x; st.y = st.home.y; place();
      setTimeout(() => { ball.style.transition = ""; st.last = performance.now(); st.raf = requestAnimationFrame(tick); }, 460);
    });
    skip.focus({ preventScroll: true });

    active = { finish };
    return true;
  }

  function close() { active?.finish(); }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  window.Court = { open, close, get isOpen() { return !!active; } };
})();
