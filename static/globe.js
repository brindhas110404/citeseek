// CiteSeek paper atlas: a 3D globe of research papers, placed so similar papers sit together.
// Data comes from static/atlas/*.json, produced by `npm run atlas:build`.
// Exposes window.Atlas.mount(element, { onAdd(record), toast(msg, type) }).
"use strict";

(function () {
  const THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
  const R = 1; // globe radius

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n).toLocaleString();

  // Conference metadata often carries LaTeX math ("$256\times256$", "$\ell_2$"). Turn the common
  // pieces into plain readable text; anything unrecognised just loses its backslash and braces.
  const TEX = {
    times: "×", cdot: "·", pm: "±", mp: "∓", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠",
    approx: "≈", sim: "~", simeq: "≃", propto: "∝", infty: "∞", to: "→", rightarrow: "→", leftarrow: "←",
    Rightarrow: "⇒", leftrightarrow: "↔", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
    sum: "Σ", prod: "Π", int: "∫", partial: "∂", nabla: "∇", sqrt: "√", ell: "ℓ", log: "log", exp: "exp",
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
    theta: "θ", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
    phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
    Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", ldots: "…", cdots: "⋯", dots: "…", star: "⋆", circ: "∘",
    top: "ᵀ", mid: "|", vert: "|", Vert: "‖", langle: "⟨", rangle: "⟩", "%": "%", "&": "&", "_": "_", "#": "#", "$": "$",
  };
  const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", n: "ⁿ", i: "ⁱ", T: "ᵀ" };
  const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋" };
  const script = (s, map, mark) => [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : `${mark}${s}`;
  function cleanMath(m) {
    return m
      .replace(/\\(?:mathrm|mathbf|mathit|mathcal|mathbb|mathsf|text|textbf|textit|operatorname|boldsymbol|emph)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|,|;|!|quad|qquad)(?![a-zA-Z])/g, (x) => (/[,;]|quad/.test(x) ? " " : ""))
      .replace(/\\([a-zA-Z]+|[%&_#$])/g, (x, w) => TEX[w] ?? w)
      .replace(/\^\{([^{}]*)\}|\^(\S)/g, (x, a, b) => script(a ?? b, SUP, "^"))
      .replace(/_\{([^{}]*)\}|_([0-9a-zA-Z])/g, (x, a, b) => script(a ?? b, SUB, "_"))
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const tex = (s) => {
    s = String(s ?? "");
    if (!/[$\\]/.test(s)) return s;
    return s
      .replace(/\$\$([^$]+)\$\$|\$([^$]+)\$|\\\(([\s\S]+?)\\\)/g, (x, a, b, c) => cleanMath(a ?? b ?? c))
      .replace(/\\(textbf|textit|emph|texttt)\{([^{}]*)\}/g, "$2")
      .replace(/\\([%&_#])/g, "$1")
      .replace(/~/g, " ");
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.THREE) return resolve();
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error("Couldn't load the 3D library"));
      document.head.appendChild(s);
    });
  }
  function decode(b64, Type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Type(bytes.buffer);
  }
  const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

  // ------------------------------------------------------------ shaders
  const VERT = `
    attribute vec3 color;
    attribute float aYear;
    attribute float aKind;
    attribute float aSub;
    attribute float aIndex;
    attribute float aMatch;
    uniform float uSize, uPixelRatio, uYearMin, uYearMax, uShowConf, uShowArxiv, uFocusSub, uSearch, uHover, uSelected;
    varying vec3 vColor;
    varying float vAlpha;
    varying float vKind;
    varying float vRing;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float a = (aYear >= uYearMin && aYear <= uYearMax) ? 1.0 : 0.0;
      a *= (aKind < 0.5) ? uShowConf : uShowArxiv;
      if (uFocusSub >= 0.0 && abs(aSub - uFocusSub) > 0.5) a *= 0.1;
      if (uSearch > 0.5 && aMatch < 0.5) a *= 0.08;
      vec3 n = normalize((modelViewMatrix * vec4(position, 0.0)).xyz);
      float facing = dot(n, normalize(-mv.xyz));
      a *= smoothstep(-0.02, 0.22, facing);
      float s = uSize * (aKind > 0.5 ? 0.9 : 1.0);
      vRing = 0.0;
      if (uSearch > 0.5 && aMatch > 0.5) s *= 1.7;
      if (abs(aIndex - uHover) < 0.5 || abs(aIndex - uSelected) < 0.5) { s *= 3.2; a = max(a, 0.95 * step(0.0, facing)); vRing = 1.0; }
      gl_PointSize = a > 0.003 ? s * uPixelRatio * (3.2 / -mv.z) : 0.0;
      vColor = color; vAlpha = a; vKind = aKind;
      gl_Position = projectionMatrix * mv;
    }`;
  const FRAG = `
    varying vec3 vColor;
    varying float vAlpha;
    varying float vKind;
    varying float vRing;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = length(c);
      if (d > 0.5) discard;
      float alpha = vAlpha * smoothstep(0.5, 0.36, d);
      vec3 col = vColor;
      // arXiv preprints: lighter centre, so they read as "open" dots
      if (vKind > 0.5) col = mix(col, vec3(1.0), smoothstep(0.24, 0.0, d) * 0.55);
      if (vRing > 0.5) col = mix(vec3(1.0), col, smoothstep(0.3, 0.42, d));
      gl_FragColor = vec4(col, alpha);
    }`;
  const ATMO_VERT = `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
  const ATMO_FRAG = `varying vec3 vN; void main(){ float i = pow(0.72 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(0.85,0.70,0.48, 1.0) * i; }`;

  // ------------------------------------------------------------ mount
  /**
   * hooks: { onAdd(record), toast(msg, type) }
   * opts:  { landing: true } for the public sign-in page (no build instructions, "Sign in to add").
   */
  async function mount(root, hooks = {}, opts = {}) {
    const addLabel = opts.landing ? "Sign in to add to your library" : "Add to my library";
    root.innerHTML = `
      <div class="atlas-stage"><canvas class="atlas-canvas" tabindex="0" role="application" aria-roledescription="globe" aria-label="Globe of research papers. Arrow keys spin it, plus and minus zoom, Enter opens the paper in the centre, Escape closes it. Or use the search box to find papers by title."></canvas><div class="sr-only" aria-live="polite" data-live></div><div class="atlas-labels"></div></div>
      <div class="atlas-head">
        <div class="atlas-kicker">${opts.landing ? "CiteSeek · Paper atlas" : "Paper atlas"}</div>
        <div class="atlas-title">Explore the research landscape</div>
        <div class="atlas-sub" data-sub aria-live="polite">Loading the globe…</div>
      </div>
      <div class="atlas-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <input type="search" placeholder="Search titles on the globe…" aria-label="Search papers on the globe" disabled />
        <div class="atlas-results" hidden></div>
      </div>
      <div class="atlas-legend" hidden></div>
      <div class="atlas-filters" hidden>
        <div class="atlas-kinds">
          <button class="kind on" data-kind="conf" aria-pressed="true"><i class="dot conf"></i>Conferences</button>
          <button class="kind on" data-kind="arxiv" aria-pressed="true"><i class="dot arxiv"></i>arXiv</button>
        </div>
        <div class="atlas-years">
          <span data-years></span>
          <div class="range2"><input type="range" data-ymin aria-label="From year"/><input type="range" data-ymax aria-label="To year"/></div>
        </div>
      </div>
      <div class="atlas-zoom"><button data-zoom="in" aria-label="Zoom in">+</button><button data-zoom="out" aria-label="Zoom out">−</button></div>
      <div class="atlas-hint">Drag to spin · pinch or ⌘/Ctrl + scroll to zoom · click a dot</div>
      <div class="atlas-tip" hidden></div>
      <aside class="atlas-card" hidden></aside>
      <div class="atlas-empty" hidden></div>`;
    const $ = (s) => root.querySelector(s);
    const live = $("[data-live]");
    const announce = (t) => { live.textContent = ""; setTimeout(() => { live.textContent = t; }, 30); };
    const canvas = $(".atlas-canvas"), labelsEl = $(".atlas-labels"), sub = $("[data-sub]");
    const tip = $(".atlas-tip"), card = $(".atlas-card"), searchInput = $(".atlas-search input"), resultsEl = $(".atlas-results");

    try { await loadScript(THREE_URL); } catch (e) { sub.textContent = e.message; return; }
    const THREE = window.THREE;

    let data = null;
    try {
      const res = await fetch("/atlas/points.json", { cache: "no-cache" });
      if (res.ok) data = await res.json();
    } catch {}

    // ---------------- scene
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
    catch { sub.textContent = "Your browser can't show 3D graphics (WebGL is off)."; return; }
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(DPR);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 3.3);
    const globe = new THREE.Group();
    globe.rotation.order = "XYZ";
    scene.add(globe);

    const ocean = new THREE.Mesh(new THREE.SphereGeometry(R * 0.985, 72, 48), new THREE.MeshBasicMaterial({ color: 0x173a2a }));
    globe.add(ocean);
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.13, 64, 48), new THREE.ShaderMaterial({ vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    scene.add(atmo);
    // faint graticule
    const gratPts = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = Math.sin(lat * Math.PI / 180) * 0.99, r = Math.cos(lat * Math.PI / 180) * 0.99;
      for (let k = 0; k < 96; k++) { const a1 = (k / 96) * Math.PI * 2, a2 = ((k + 1) / 96) * Math.PI * 2; gratPts.push(r * Math.cos(a1), y, r * Math.sin(a1), r * Math.cos(a2), y, r * Math.sin(a2)); }
    }
    for (let lon = 0; lon < 180; lon += 30) {
      for (let k = 0; k < 96; k++) {
        const t1 = (k / 96) * Math.PI * 2, t2 = ((k + 1) / 96) * Math.PI * 2, ph = lon * Math.PI / 180;
        gratPts.push(Math.cos(t1) * Math.cos(ph) * 0.99, Math.sin(t1) * 0.99, Math.cos(t1) * Math.sin(ph) * 0.99, Math.cos(t2) * Math.cos(ph) * 0.99, Math.sin(t2) * 0.99, Math.cos(t2) * Math.sin(ph) * 0.99);
      }
    }
    const grat = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(gratPts, 3)), new THREE.LineBasicMaterial({ color: 0xe8dfcc, transparent: true, opacity: 0.06 }));
    globe.add(grat);

    // ---------------- points
    const N = data ? data.count : 2400;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const yearA = new Float32Array(N), kindA = new Float32Array(N), subA = new Float32Array(N), idxA = new Float32Array(N), matchA = new Float32Array(N);
    let topicArr = null, yearRaw = null, kindRaw = null, venueRaw = null, citesRaw = null;
    if (data) {
      const p16 = decode(data.pos, Int16Array);
      topicArr = decode(data.topic, Uint16Array); yearRaw = decode(data.year, Uint8Array); kindRaw = decode(data.kind, Uint8Array);
      venueRaw = decode(data.venue, Uint8Array); citesRaw = decode(data.cites, Uint16Array);
      const subColors = data.subfields.map((s) => hexToRgb(s.color));
      for (let i = 0; i < N; i++) {
        const x = p16[i * 3] / 32767, y = p16[i * 3 + 1] / 32767, z = p16[i * 3 + 2] / 32767;
        const n = Math.hypot(x, y, z) || 1, lift = 1.004 + (citesRaw[i] > 500 ? 0.004 : 0);
        pos[i * 3] = (x / n) * lift; pos[i * 3 + 1] = (y / n) * lift; pos[i * 3 + 2] = (z / n) * lift;
        const s = data.topics[topicArr[i]].sub;
        const c = subColors[s] || [0.8, 0.75, 0.62];
        const shade = 0.82 + 0.18 * ((topicArr[i] * 7919) % 97) / 97; // topics within a continent vary slightly
        col[i * 3] = c[0] * shade; col[i * 3 + 1] = c[1] * shade; col[i * 3 + 2] = c[2] * shade;
        yearA[i] = 2000 + yearRaw[i]; kindA[i] = kindRaw[i]; subA[i] = s; idxA[i] = i;
      }
    } else {
      // Placeholder: a decorative scatter so the globe isn't empty before the atlas is built.
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
        pos[i * 3] = Math.cos(th) * r * 1.004; pos[i * 3 + 1] = y * 1.004; pos[i * 3 + 2] = Math.sin(th) * r * 1.004;
        col[i * 3] = 0.85; col[i * 3 + 1] = 0.78; col[i * 3 + 2] = 0.62; yearA[i] = 2020; idxA[i] = i;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geom.setAttribute("aYear", new THREE.BufferAttribute(yearA, 1));
    geom.setAttribute("aKind", new THREE.BufferAttribute(kindA, 1));
    geom.setAttribute("aSub", new THREE.BufferAttribute(subA, 1));
    geom.setAttribute("aIndex", new THREE.BufferAttribute(idxA, 1));
    const matchAttr = new THREE.BufferAttribute(matchA, 1);
    matchAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("aMatch", matchAttr);
    const years = data ? data.years : [2018, new Date().getFullYear()];
    const uniforms = {
      uSize: { value: N > 30000 ? 2.0 : N > 8000 ? 2.6 : 3.4 }, uPixelRatio: { value: DPR },
      uYearMin: { value: years[0] }, uYearMax: { value: years[1] },
      uShowConf: { value: 1 }, uShowArxiv: { value: 1 }, uFocusSub: { value: -1 },
      uSearch: { value: 0 }, uHover: { value: -1 }, uSelected: { value: -1 },
    };
    const points = new THREE.Points(geom, new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, transparent: true, depthWrite: false }));
    globe.add(points);

    // ---------------- sizing
    function resize() {
      const w = root.clientWidth, h = root.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // Keep the whole globe in view on narrow screens.
      camera.position.z = Math.max(zoomMin, Math.min(zoomMax, camera.position.z));
      fitZ = w / h < 0.9 ? 4.2 : 3.3;
      camera.updateProjectionMatrix();
    }
    const zoomMin = 1.45, zoomMax = 5.2;
    let fitZ = 3.3;
    new ResizeObserver(resize).observe(root);
    resize();
    camera.position.z = fitZ;

    // ---------------- interaction: drag to spin (with inertia), wheel/pinch to zoom
    const rot = { x: 0.35, y: 0.6, vx: 0, vy: 0 };
    let target = null; // fly-to target {x, y}
    let dragging = false, moved = 0, lastX = 0, lastY = 0, lastInteract = 0;
    const pointers = new Map();
    let pinchDist = 0;
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); }
      dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; target = null; lastInteract = performance.now();
      root.classList.add("grabbing");
    });
    canvas.addEventListener("pointermove", (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist) zoomBy(pinchDist / d);
        pinchDist = d; moved += 10;
        return;
      }
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
        const k = 0.0042 * (camera.position.z / 3.3);
        rot.vy = dx * k; rot.vx = dy * k;
        rot.y += rot.vy; rot.x = Math.max(-1.35, Math.min(1.35, rot.x + rot.vx));
        lastInteract = performance.now();
        hideTip();
      } else {
        queuePick(e);
      }
    });
    const endDrag = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (!dragging) return;
      dragging = pointers.size > 0;
      root.classList.remove("grabbing");
      if (moved < 6) { // a click, not a drag
        const hit = pick(e.clientX, e.clientY);
        if (hit >= 0) openCard(hit); else closeCard();
      }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => { if (!dragging) hideTip(); });
    function zoomBy(f) {
      camera.position.z = Math.max(zoomMin, Math.min(zoomMax, camera.position.z * f));
      lastInteract = performance.now();
    }
    // Plain scrolling keeps scrolling the page; trackpad pinch (sent as ctrl+wheel) or ⌘/Ctrl + scroll zooms.
    canvas.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(Math.exp(e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0015)));
    }, { passive: false });
    root.querySelector(".atlas-zoom").addEventListener("click", (e) => {
      const b = e.target.closest("[data-zoom]");
      if (!b) return;
      target = { x: rot.x, y: rot.y, z: Math.max(zoomMin, Math.min(zoomMax, camera.position.z * (b.dataset.zoom === "in" ? 0.78 : 1.28))) };
    });

    // ---------------- keyboard
    let openedByKey = false;
    canvas.addEventListener("keydown", (e) => {
      const k = e.key;
      const step = 0.14 * (camera.position.z / 3.3);
      if (k === "ArrowLeft" || k === "ArrowRight") { rot.y += k === "ArrowLeft" ? -step : step; }
      else if (k === "ArrowUp" || k === "ArrowDown") { rot.x = Math.max(-1.35, Math.min(1.35, rot.x + (k === "ArrowUp" ? -step : step))); }
      else if (k === "+" || k === "=") zoomBy(0.85);
      else if (k === "-" || k === "_") zoomBy(1.18);
      else if (k === "Enter" || k === " ") {
        // The visible paper nearest the centre of the globe.
        const r = canvas.getBoundingClientRect();
        let hit = -1;
        for (let rad = 0; rad <= 60 && hit < 0; rad += 6) {
          for (let a = 0; a < (rad ? 12 : 1) && hit < 0; a++) hit = pick(r.left + r.width / 2 + rad * Math.cos(a * 0.52), r.top + r.height / 2 + rad * Math.sin(a * 0.52));
        }
        if (hit >= 0) { openedByKey = true; openCard(hit); } else announce("No paper in the centre. Spin or zoom in and try again.");
      } else if (k === "Escape") closeCard();
      else return;
      e.preventDefault();
      target = null; rot.vx = rot.vy = 0; lastInteract = performance.now();
    });

    // ---------------- picking
    const v = new THREE.Vector3();
    function visibleIdx(i) {
      if (!data) return false;
      const y = 2000 + yearRaw[i];
      if (y < uniforms.uYearMin.value || y > uniforms.uYearMax.value) return false;
      if (kindRaw[i] === 0 ? !uniforms.uShowConf.value : !uniforms.uShowArxiv.value) return false;
      if (uniforms.uFocusSub.value >= 0 && data.topics[topicArr[i]].sub !== uniforms.uFocusSub.value) return false;
      if (uniforms.uSearch.value && !matchA[i]) return false;
      return true;
    }
    function pick(cx, cy) {
      if (!data) return -1;
      const rect = canvas.getBoundingClientRect();
      const mx = cx - rect.left, my = cy - rect.top;
      globe.updateMatrixWorld();
      const m = globe.matrixWorld.elements;
      const radius = Math.max(7, 11 - camera.position.z);
      let best = -1, bestD = radius * radius;
      for (let i = 0; i < N; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const wz = m[2] * x + m[6] * y + m[10] * z;
        if (wz < 0.15) continue; // back of the globe
        if (!visibleIdx(i)) continue;
        v.set(m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, wz).project(camera);
        const sx = (v.x * 0.5 + 0.5) * rect.width, sy = (-v.y * 0.5 + 0.5) * rect.height;
        const d = (sx - mx) ** 2 + (sy - my) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    let pickQueued = null;
    function queuePick(e) {
      if (pickQueued) { pickQueued = e; return; }
      pickQueued = e;
      requestAnimationFrame(() => {
        const ev = pickQueued; pickQueued = null;
        const hit = pick(ev.clientX, ev.clientY);
        uniforms.uHover.value = hit;
        canvas.style.cursor = hit >= 0 ? "pointer" : "grab";
        if (hit >= 0) showTip(hit, ev); else hideTip();
      });
    }

    // ---------------- titles + paper details (lazy)
    // Newer atlases ship titles in chunks + a split word index (nothing big downloaded up
    // front). Older ones ship one titles.json; both work.
    let titles = null, titlesLoading = null;
    const chunked = () => !!data?.titleChunk;
    const titleChunks = new Map(); // chunk number → Promise<string[]>
    const titleCache = new Map();  // paper index → title
    function chunkFor(i) {
      const c = Math.floor(i / data.titleChunk);
      if (!titleChunks.has(c)) titleChunks.set(c, fetch(`/atlas/titles/${c}.json`).then((r) => r.json()).then((list) => {
        list.forEach((t, k) => titleCache.set(c * data.titleChunk + k, t));
        return list;
      }).catch(() => { titleChunks.delete(c); return []; }));
      return titleChunks.get(c);
    }
    const titleNow = (i) => (chunked() ? titleCache.get(i) : titles?.[i]);
    async function titleOf(i) { if (chunked()) { await chunkFor(i); return titleCache.get(i) || ""; } await loadTitles(); return titles?.[i] || ""; }
    const pages = new Map();
    function loadTitles() {
      if (!data || titles || chunked()) return Promise.resolve(titles);
      titlesLoading = titlesLoading || fetch("/atlas/titles.json").then((r) => r.json()).then((t) => (titles = t)).catch(() => null);
      return titlesLoading;
    }
    async function record(i) {
      const p = Math.floor(i / data.pageSize);
      if (!pages.has(p)) pages.set(p, fetch(`/atlas/pages/${p}.json`).then((r) => r.json()));
      return (await pages.get(p))[i % data.pageSize];
    }
    const venueName = (i) => kindRaw[i] === 1 ? "arXiv" : data.venues[venueRaw[i]] || "Conference";

    function showTip(i, ev) {
      const rect = root.getBoundingClientRect();
      const t = titleNow(i) ?? "…";
      const s = data.subfields[data.topics[topicArr[i]].sub];
      tip.innerHTML = `<div class="tip-title">${esc(tex(t))}</div><div class="tip-meta"><i style="background:${s.color}"></i>${esc(venueName(i))} ${2000 + yearRaw[i]}${citesRaw[i] ? ` · ${fmt(citesRaw[i])} citations` : ""}</div>`;
      tip.hidden = false;
      const x = Math.min(ev.clientX - rect.left + 14, rect.width - 300), y = Math.max(ev.clientY - rect.top - 12, 8);
      tip.style.transform = `translate(${x}px, ${y}px)`;
      if (t === "…") titleOf(i).then(() => { if (!tip.hidden && uniforms.uHover.value === i) showTip(i, ev); });
    }
    function hideTip() { tip.hidden = true; uniforms.uHover.value = -1; }

    // ---------------- paper card
    let current = -1;
    async function openCard(i) {
      current = i;
      uniforms.uSelected.value = i;
      const s = data.subfields[data.topics[topicArr[i]].sub];
      const topicName = data.topics[topicArr[i]].name;
      card.hidden = false;
      card.innerHTML = `<div class="card-loading">Loading paper…</div>`;
      let rec;
      try { rec = await record(i); } catch { card.innerHTML = `<div class="card-loading">Couldn't load this paper's details.</div>`; return; }
      if (current !== i) return;
      card.innerHTML = `
        <button class="card-close" aria-label="Close">×</button>
        <div class="card-venue"><span class="venue-pill ${kindRaw[i] ? "arxiv" : ""}">${esc(venueName(i))} ${rec.y}</span>${rec.d ? `<span class="card-domain">${esc(rec.d)}</span>` : ""}${rec.c ? `<span>${fmt(rec.c)} citations</span>` : ""}</div>
        <h3 class="card-title">${esc(tex(rec.t))}</h3>
        <div class="card-authors">${esc(rec.a || "Unknown authors")}</div>
        <button class="card-topic" data-topic="${topicArr[i]}" title="Highlight papers on this topic"><i style="background:${s.color}"></i>${esc(topicName)} · ${esc(s.name)}</button>
        <p class="card-abstract">${rec.ab ? esc(tex(rec.ab)) + (rec.ab.length >= 1400 ? "…" : "") : "<em>Looking for the abstract…</em>"}</p>
        <div class="card-fallback" hidden></div>
        <div class="card-actions">
          <button class="btn btn-primary" data-add>${rec.pdf || opts.landing ? addLabel : "Find a free PDF & add"}</button>
          <a class="btn btn-ghost" href="${esc(rec.url)}" target="_blank" rel="noopener">Open paper ↗</a>
        </div>`;
      // The conference data had no abstract: look it up by title (arXiv / Semantic Scholar / OpenAlex).
      if (!rec.ab) {
        fetch(`/api/atlas/lookup?title=${encodeURIComponent(rec.t)}`).then((r) => r.json()).catch(() => ({})).then((d) => {
          if (current !== i) return;
          const el = card.querySelector(".card-abstract");
          if (d.abstract) {
            rec.ab = d.abstract;
            el.innerHTML = `${esc(tex(d.abstract.slice(0, 1400)))}${d.abstract.length > 1400 ? "…" : ""} <span class="ab-src">Abstract via ${esc(d.abstractSource)}</span>`;
          } else {
            el.innerHTML = "<em>No abstract is published for this paper. Open the paper to read it.</em>";
          }
        });
      }
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-label", rec.t);
      announce(`Opened ${rec.t}, ${venueName(i)} ${rec.y}.`);
      if (openedByKey) { openedByKey = false; card.querySelector(".card-close").focus({ preventScroll: true }); }
      card.onkeydown = (e) => { if (e.key === "Escape") { closeCard(); canvas.focus({ preventScroll: true }); } };
      card.querySelector(".card-close").onclick = closeCard;
      card.querySelector("[data-topic]").onclick = () => highlightTopic(topicArr[i], topicName);
      const add = card.querySelector("[data-add]");
      if (add) add.onclick = async () => {
        add.disabled = true; add.textContent = opts.landing ? "Sign in first…" : "Fetching PDF…";
        try { await hooks.onAdd?.(rec); add.textContent = "Added ✓"; }
        catch (err) {
          add.disabled = false;
          add.textContent = rec.pdf || opts.landing ? addLabel : "Find a free PDF & add";
          if (err.code === "no_pdf") showFallback(err.message);
          else if (err.message) hooks.toast?.(err.message, "error");
        }
      };
      // Nothing downloadable anywhere: offer the paper page + "upload it yourself".
      function showFallback(detail) {
        const box = card.querySelector(".card-fallback");
        box.hidden = false;
        box.innerHTML = `<strong>No free copy we could download.</strong>
          <span>Many publishers block automatic downloads. Download the PDF from the paper's page yourself, then upload it and it's added with this title.</span>
          <span class="fb-detail">${esc(detail)}</span>
          <span class="fb-actions">
            <a class="btn btn-ghost" href="${esc(rec.url)}" target="_blank" rel="noopener">1. Open paper page ↗</a>
            <button class="btn btn-primary" data-own>2. Upload the PDF</button>
          </span>`;
        box.querySelector("[data-own]").onclick = () => hooks.onUploadOwn?.(rec);
        card.querySelector(".card-actions").hidden = true; // the box has its own buttons
        box.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
    function closeCard() { card.hidden = true; current = -1; uniforms.uSelected.value = -1; }

    // ---------------- fly to a paper
    function flyTo(i) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      let ty = Math.atan2(-x, z);
      const tx = Math.atan2(y, Math.hypot(x, z));
      // shortest way round
      ty = rot.y + ((((ty - rot.y) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      target = { x: Math.max(-1.35, Math.min(1.35, tx)), y: ty, z: Math.min(camera.position.z, 2.4) };
      rot.vx = rot.vy = 0;
      lastInteract = performance.now();
    }

    // ---------------- search
    let matches = [];
    function setMatches(list) {
      matchA.fill(0);
      for (const i of list) matchA[i] = 1;
      matchAttr.needsUpdate = true;
      uniforms.uSearch.value = list.length ? 1 : 0;
    }
    function highlightTopic(t, name) {
      const list = [];
      for (let i = 0; i < N; i++) if (topicArr[i] === t) list.push(i);
      matches = list;
      setMatches(list);
      searchInput.value = `topic: ${name}`;
      resultsEl.hidden = true;
      sub.textContent = `${fmt(list.length)} papers on “${name}”`;
    }
    let searchTimer = 0;
    searchInput.addEventListener("focus", () => { if (!chunked()) loadTitles(); });
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 160);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && matches.length) { e.preventDefault(); select(matches[0]); }
      if (e.key === "Escape") { searchInput.value = ""; runSearch(); searchInput.blur(); }
      if (e.key === "ArrowDown" && !resultsEl.hidden) { e.preventDefault(); resultsEl.querySelector("button")?.focus(); }
    });
    async function runSearch() {
      const q = searchInput.value.trim().toLowerCase();
      if (!q || q.startsWith("topic:")) { if (!q) { matches = []; setMatches([]); resultsEl.hidden = true; updateSub(); } return; }
      const list = chunked() ? await searchIndex(q) : await searchAllTitles(q);
      if (list === null || searchInput.value.trim().toLowerCase() !== q) return; // a newer search took over
      list.sort((a, b) => citesRaw[b] - citesRaw[a] || yearRaw[b] - yearRaw[a]);
      matches = list;
      setMatches(list.slice(0, 5000));
      sub.textContent = list.length ? `${fmt(list.length)} matching paper${list.length === 1 ? "" : "s"}` : "No matching titles";
      resultsEl.hidden = !list.length;
      await Promise.all(list.slice(0, 7).map(titleOf));
      resultsEl.innerHTML = list.slice(0, 7).map((i) => `<button data-i="${i}"><span>${esc(tex(titleNow(i) || ""))}</span><small>${esc(venueName(i))} ${2000 + yearRaw[i]}${citesRaw[i] ? ` · ${fmt(citesRaw[i])} cites` : ""}</small></button>`).join("")
        + (list.length > 7 ? `<div class="more">+ ${fmt(list.length - 7)} more highlighted on the globe</div>` : "");
    }
    // Old atlases: scan every title.
    async function searchAllTitles(q) {
      await loadTitles();
      if (!titles) return null;
      const words = q.split(/\s+/).filter(Boolean);
      const list = [];
      for (let i = 0; i < titles.length; i++) { const t = titles[i].toLowerCase(); if (words.every((w) => t.includes(w))) list.push(i); }
      return list;
    }
    // New atlases: words are matched as prefixes ("diffu" finds "diffusion"); each word only
    // loads the index piece for its first two letters.
    const shards = new Map();
    const STOP = new Set("a an the of for and or in on to with by from via is are be as at its into".split(" "));
    const shard = (key) => {
      if (!(data.searchShards || []).includes(key)) return Promise.resolve({});
      if (!shards.has(key)) shards.set(key, fetch(`/atlas/search/${key}.json`).then((r) => r.json()).catch(() => { shards.delete(key); return {}; }));
      return shards.get(key);
    };
    async function searchIndex(q) {
      const words = q.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));
      if (!words.length) return [];
      let result = null;
      for (const w of words) {
        const idx = await shard(w.slice(0, 2));
        const hits = new Set();
        for (const tok in idx) {
          if (!tok.startsWith(w)) continue;
          let id = 0;
          idx[tok].forEach((gap, k) => { id = k ? id + gap : gap; hits.add(id); });
        }
        result = result ? new Set([...result].filter((x) => hits.has(x))) : hits;
        if (!result.size) break;
      }
      return [...(result || [])];
    }
    resultsEl.addEventListener("keydown", (e) => {
      const btns = [...resultsEl.querySelectorAll("button")];
      const at = btns.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); btns[Math.min(btns.length - 1, at + 1)]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); at <= 0 ? searchInput.focus() : btns[at - 1].focus(); }
      else if (e.key === "Escape") { resultsEl.hidden = true; searchInput.focus(); }
    });
    resultsEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (b) select(+b.dataset.i);
    });
    function select(i) { resultsEl.hidden = true; flyTo(i); openedByKey = document.activeElement?.closest?.(".atlas-results") != null; openCard(i); }
    const onDocClick = (e) => { if (!root.querySelector(".atlas-search")?.contains(e.target)) resultsEl.hidden = true; };
    document.addEventListener("click", onDocClick);

    // ---------------- legend, filters, labels
    function updateSub() {
      if (!data) return;
      const used = Object.keys(data.counts.byVenue || {}).filter((v) => v !== "arXiv");
      const venues = used.length > 6 ? `${used.length} conferences` : (used.length ? used : data.venues).join(", ");
      sub.textContent = `${fmt(data.count)} papers · ${venues}${data.counts.arxiv ? " + arXiv" : ""} · ${data.years[0]}–${data.years[1]}`;
      sub.title = used.length ? `Conferences: ${used.join(", ")}` : "";
    }
    const labelEls = [];
    if (data) {
      updateSub();
      searchInput.disabled = false;
      const legend = $(".atlas-legend");
      legend.hidden = false;
      // Regions dropdown: one compact button; the list (all regions, adding up to the total) opens upward.
      const maxCount = Math.max(1, ...data.subfields.map((r) => r.count));
      legend.innerHTML = `
        <div class="legend-menu" role="menu" aria-label="Regions" hidden>
          <button class="legend-row all on" data-sub="-1" role="menuitemradio" aria-checked="true"><i class="all-dot"></i><span class="lr-name">All regions</span><small>${fmt(data.count)}</small></button>
          ${data.subfields.map((r, i) => `
            <button class="legend-row" data-sub="${i}" role="menuitemradio" aria-checked="false" title="Show only ${esc(r.name)}">
              <i style="background:${r.color}"></i><span class="lr-name">${esc(r.name)}</span><small>${fmt(r.count)}</small>
              <span class="lr-bar"><span style="width:${(r.count / maxCount * 100).toFixed(1)}%;background:${r.color}"></span></span>
            </button>`).join("")}
        </div>
        <button class="legend-toggle" aria-haspopup="menu" aria-expanded="false">
          <i class="all-dot"></i><span class="lt-label">All ${data.subfields.length} regions</span><small>${fmt(data.count)}</small><span class="lt-chev">▾</span>
        </button>`;
      const menu = legend.querySelector(".legend-menu");
      const toggle = legend.querySelector(".legend-toggle");
      const setOpen = (open) => {
        menu.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); legend.classList.toggle("open", open);
        if (open) (menu.querySelector(".legend-row.on") || menu.querySelector(".legend-row"))?.focus({ preventScroll: true });
      };
      menu.addEventListener("keydown", (e) => {
        const rows = [...menu.querySelectorAll(".legend-row")];
        const at = rows.indexOf(document.activeElement);
        if (e.key === "ArrowDown") { e.preventDefault(); rows[Math.min(rows.length - 1, at + 1)].focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); rows[Math.max(0, at - 1)].focus(); }
        else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); toggle.focus(); }
      });
      const focusRegion = (i) => {
        uniforms.uFocusSub.value = i;
        menu.querySelectorAll(".legend-row").forEach((x) => { x.classList.toggle("on", +x.dataset.sub === i); x.setAttribute("aria-checked", String(+x.dataset.sub === i)); });
        announce(i >= 0 ? `Showing only ${data.subfields[i].name}, ${fmt(data.subfields[i].count)} papers.` : "Showing all regions.");
        const r = data.subfields[i];
        toggle.querySelector("i").outerHTML = r ? `<i style="background:${r.color}"></i>` : `<i class="all-dot"></i>`;
        toggle.querySelector(".lt-label").textContent = r ? r.name : `All ${data.subfields.length} regions`;
        toggle.querySelector("small").textContent = fmt(r ? r.count : data.count);
        if (r) flyToDir(r.center);
      };
      legend.addEventListener("click", (e) => {
        if (e.target.closest(".legend-toggle")) return setOpen(menu.hidden);
        const b = e.target.closest("[data-sub]");
        if (!b) return;
        const i = +b.dataset.sub;
        focusRegion(uniforms.uFocusSub.value === i ? -1 : i);
        setOpen(false);
      });
      document.addEventListener("click", (e) => { if (!menu.hidden && !legend.contains(e.target)) setOpen(false); });
      root.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) setOpen(false); });
      // Continent labels for the biggest subfields
      for (const s of data.subfields.slice(0, 8)) {
        const el = document.createElement("div");
        el.className = "atlas-label";
        el.textContent = s.name;
        labelsEl.appendChild(el);
        labelEls.push({ el, c: new THREE.Vector3(...s.center).multiplyScalar(1.02) });
      }
      // Filters
      const filters = $(".atlas-filters");
      filters.hidden = false;
      const [y0, y1] = data.years;
      const ymin = $("[data-ymin]"), ymax = $("[data-ymax]"), ylabel = $("[data-years]");
      for (const r of [ymin, ymax]) { r.min = y0; r.max = y1; r.step = 1; }
      ymin.value = y0; ymax.value = y1;
      const syncYears = () => {
        let a = +ymin.value, b = +ymax.value;
        if (a > b) [a, b] = [b, a];
        uniforms.uYearMin.value = a; uniforms.uYearMax.value = b;
        ylabel.textContent = a === b ? `${a}` : `${a} – ${b}`;
      };
      ymin.oninput = ymax.oninput = syncYears;
      syncYears();
      filters.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
        const on = !b.classList.contains("on");
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
        uniforms[b.dataset.kind === "conf" ? "uShowConf" : "uShowArxiv"].value = on ? 1 : 0;
      }));
      if (!data.counts.arxiv) filters.querySelector('[data-kind="arxiv"]').hidden = true;
      if (!chunked()) setTimeout(loadTitles, 1500); // old atlases: get hover titles ready
    } else {
      const empty = $(".atlas-empty");
      if (opts.landing) {
        // Visitors just see the decorative globe until the atlas has been built.
        sub.textContent = "Ask research papers anything and get cited answers.";
      } else {
        empty.hidden = false;
        empty.innerHTML = `<b>Your paper atlas isn't built yet</b>
          <p>Download about 150,000 papers on AI and the fields it touches (NeurIPS, ICML, ICLR, ACL, CVPR, CoRL and 16 more conferences, plus recent arXiv) and map them onto this globe. In your project folder, run:</p>
          <code>npm run atlas:build</code>
          <p class="small">It takes a few minutes and needs internet. Keep <code>npm run dev</code> running for the best layout, then reload this page.</p>`;
        sub.textContent = "Not built yet";
      }
    }
    function flyToDir(c) {
      const [x, y, z] = c;
      let ty = Math.atan2(-x, z);
      ty = rot.y + ((((ty - rot.y) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      target = { x: Math.max(-1.35, Math.min(1.35, Math.atan2(y, Math.hypot(x, z)))), y: ty, z: camera.position.z };
    }

    // ---------------- render loop (paused when hidden)
    let running = true, raf = 0;
    const tmp = new THREE.Vector3();
    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!running) return;
      if (target) {
        rot.x += (target.x - rot.x) * 0.08; rot.y += (target.y - rot.y) * 0.08;
        camera.position.z += (target.z - camera.position.z) * 0.08;
        if (Math.abs(target.x - rot.x) + Math.abs(target.y - rot.y) < 0.002 && Math.abs(target.z - camera.position.z) < 0.005) target = null;
      } else if (!dragging) {
        rot.vx *= 0.93; rot.vy *= 0.93;
        rot.y += rot.vy; rot.x = Math.max(-1.35, Math.min(1.35, rot.x + rot.vx));
        if (now - lastInteract > 5000 && current < 0) rot.y += 0.0009; // gentle idle spin
      }
      globe.rotation.x = rot.x; globe.rotation.y = rot.y;
      renderer.render(scene, camera);
      // labels
      if (labelEls.length) {
        globe.updateMatrixWorld();
        const w = root.clientWidth, h = root.clientHeight;
        for (const l of labelEls) {
          tmp.copy(l.c).applyMatrix4(globe.matrixWorld);
          const facing = tmp.z;
          tmp.project(camera);
          const op = Math.max(0, Math.min(1, (facing - 0.5) * 4)) * (uniforms.uSearch.value || current >= 0 ? 0.3 : 1);
          l.el.style.opacity = op.toFixed(2);
          l.el.style.transform = `translate(-50%, -50%) translate(${((tmp.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-tmp.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
        }
      }
    }
    raf = requestAnimationFrame(frame);
    const io = new IntersectionObserver(([entry]) => { running = entry.isIntersecting && !document.hidden; }, { threshold: 0.02 });
    io.observe(root);
    const onVis = () => { running = !document.hidden; };
    document.addEventListener("visibilitychange", onVis);
    return finish();

    function finish() {
      root.classList.add("ready");
      return {
        data,
        pause() { running = false; },
        resume() { running = true; },
        /** Stops rendering and frees the GPU context (used when leaving the sign-in page). */
        destroy() {
          cancelAnimationFrame(raf);
          io?.disconnect();
          document.removeEventListener("click", onDocClick);
          document.removeEventListener("visibilitychange", onVis);
          geom.dispose(); points.material.dispose();
          renderer.dispose();
          renderer.forceContextLoss?.();
          root.innerHTML = "";
          root.classList.remove("ready");
        },
      };
    }
  }

  window.Atlas = { mount };
})();
