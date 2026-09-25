// Browser-side code for live "pulse" mode, embedded into the generated pages.
//
// It only wakes up when a page is served by pulse/codebase_pulse.py (same
// origin, so no CORS and the token cookie authenticates the stream). Opened
// from disk the pages stay static.
//
// The strings below are plain ES5-style JavaScript without backslashes or
// template literals, so they can sit inside a TypeScript template string.
/** Shared: connect to the stream, replay the recent past, then go live. */
const PULSE_CONNECT_JS = `
  function pulseConnect(onInfo, onEvent, onState) {
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    fetch("/pulse/info", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info) return;
        onInfo(info);
        var source = new EventSource("/pulse/events?replay=20");
        source.addEventListener("replay", function (m) {
          var past = JSON.parse(m.data);
          if (!past.length) return;
          // Replay what happened before the page opened, compressed to a few seconds
          var first = past[0].t, span = past[past.length - 1].t - first;
          var speed = Math.max(1, span / 6000);
          onState("replaying the last " + Math.round(span / 1000) + " s");
          past.forEach(function (ev) { setTimeout(function () { onEvent(ev); }, (ev.t - first) / speed); });
          setTimeout(function () { onState("live"); }, span / speed + 50);
        });
        source.onmessage = function (m) { onEvent(JSON.parse(m.data)); };
        source.onopen = function () { onState("live"); };
        source.onerror = function () { onState("program ended"); source.close(); };
      })
      .catch(function () {});
  }
`;
/** Graph pages: glowing nodes, signals travelling along edges, parked-task rings. */
export const PULSE_GRAPH_JS = `${PULSE_CONNECT_JS}
  (function () {
    var pill = document.getElementById("pulse"), pillText = document.getElementById("pulse-text");
    var inView = {}, radius = {}, groupOfNode = {};
    var values = DATA.nodes.map(function (n) { return n.value; });
    var vmin = Math.min.apply(null, values), vmax = Math.max.apply(null, values);
    DATA.nodes.forEach(function (n) {
      inView[n.id] = true;
      groupOfNode[n.id] = n.group;
      radius[n.id] = vmax === vmin ? 16 : 7 + ((n.value - vmin) / (vmax - vmin)) * 37;
    });

    var heat = {}, parked = {}, bursts = [], particles = [], lastSpawn = {};
    var state = "", currentFile = "", currentShown = true, lastActivity = 0;

    function rgba(hex, alpha) {
      var v = parseInt(hex.slice(1), 16);
      return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + alpha + ")";
    }

    function onEvent(ev) {
      var now = performance.now();
      (ev.a || []).forEach(function (chain) {
        lastActivity = now;
        currentFile = chain[chain.length - 1];
        currentShown = !!inView[currentFile];
        var shown = chain.filter(function (f) { return inView[f]; });
        shown.forEach(function (f, i) {
          var add = i === shown.length - 1 ? 0.9 : 0.22;
          heat[f] = Math.min(1.5, (heat[f] || 0) + add);
        });
        // The signal runs caller -> callee between the files that are on screen
        for (var i = 0; i + 1 < shown.length; i++) {
          var key = shown[i] + ">" + shown[i + 1];
          if (now - (lastSpawn[key] || 0) < 220) continue;
          lastSpawn[key] = now;
          particles.push({ from: shown[i], to: shown[i + 1], t0: now, dur: 420 });
        }
      });
      (ev.h || []).forEach(function (chain) {
        for (var i = chain.length - 1; i >= 0; i--) {
          if (inView[chain[i]]) { parked[chain[i]] = now; break; }
        }
      });
      (ev.i || []).forEach(function (f) { if (inView[f]) bursts.push({ id: f, t0: now }); });
    }

    function label() {
      if (!pill) return;
      var idle = performance.now() - lastActivity > 1200;
      var text = state;
      if (state === "live") {
        text = idle || !currentFile ? "live, waiting" : "live in " + currentFile + (currentShown ? "" : " (not in this view)");
      }
      pillText.textContent = text;
      pill.className = "pulse" + (state === "live" && !idle ? " busy" : "");
    }

    network.on("beforeDrawing", function (ctx) {
      var now = performance.now(), zoom = network.getScale();
      ctx.save();
      ctx.globalCompositeOperation = dark() ? "lighter" : "source-over";
      Object.keys(heat).forEach(function (id) {
        var h = heat[id], p = network.getPosition(id), r = radius[id];
        // Never smaller than ~30 px on screen, so activity shows on a zoomed-out graph too
        var reach = Math.max(r * (2.4 + 2.3 * Math.min(h, 1.2)) + 14, (22 + 16 * Math.min(h, 1.2)) / zoom);
        var glow = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, reach);
        var color = fillOf(groupOfNode[id]);
        glow.addColorStop(0, rgba(color, Math.min(0.95, 0.8 * h)));
        glow.addColorStop(0.45, rgba(color, Math.min(0.5, 0.32 * h)));
        glow.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(p.x, p.y, reach, 0, 6.2832); ctx.fill();
      });
      ctx.restore();
      // A file a thread or task is parked in: a slow breathing ring
      Object.keys(parked).forEach(function (id) {
        var age = now - parked[id];
        if (age > 1100) { delete parked[id]; return; }
        var p = network.getPosition(id), r = radius[id];
        var breath = 0.5 + 0.5 * Math.sin(now / 420);
        ctx.strokeStyle = rgba(fillOf(groupOfNode[id]), (0.25 + 0.3 * breath) * (1 - age / 1100));
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 5 + 3 * breath, 0, 6.2832); ctx.stroke();
      });
    });

    network.on("afterDrawing", function (ctx) {
      var now = performance.now(), scale = network.getScale();
      // Hot files flash towards white from the inside
      Object.keys(heat).forEach(function (id) {
        var p = network.getPosition(id);
        ctx.fillStyle = "rgba(255,255,255," + Math.min(0.6, 0.5 * heat[id]) + ")";
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(radius[id], 4 / scale), 0, 6.2832); ctx.fill();
      });
      bursts.forEach(function (b) {
        var k = (now - b.t0) / 650, p = network.getPosition(b.id);
        if (k >= 1) return;
        ctx.strokeStyle = rgba(fillOf(groupOfNode[b.id]), 0.8 * (1 - k));
        ctx.lineWidth = 2 / scale;
        ctx.beginPath(); ctx.arc(p.x, p.y, radius[b.id] + (34 / scale) * k, 0, 6.2832); ctx.stroke();
      });
      var ink = dark() ? "255,255,255" : "20,20,20";
      particles.forEach(function (s) {
        var k = (now - s.t0) / s.dur;
        if (k < 0 || k >= 1) return;
        var a = network.getPosition(s.from), b = network.getPosition(s.to);
        for (var tail = 0; tail < 4; tail++) {
          var kk = k - tail * 0.06;
          if (kk < 0) break;
          ctx.fillStyle = "rgba(" + ink + "," + (0.95 - tail * 0.22) + ")";
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * kk, a.y + (b.y - a.y) * kk, (3.4 - tail * 0.6) / scale, 0, 6.2832);
          ctx.fill();
        }
      });
    });

    var lastFrame = performance.now(), lastLabel = 0, lastDraw = 0;
    function frame(now) {
      var dt = now - lastFrame; lastFrame = now;
      var decay = Math.pow(0.5, dt / 280), alive = false;
      Object.keys(heat).forEach(function (id) {
        heat[id] *= decay;
        if (heat[id] < 0.02) delete heat[id]; else alive = true;
      });
      particles = particles.filter(function (s) { return now - s.t0 < s.dur; });
      bursts = bursts.filter(function (b) { return now - b.t0 < 650; });
      // 30 fps is plenty for a glow and keeps a 200-node graph cheap to animate
      var animating = alive || particles.length || bursts.length || Object.keys(parked).length;
      if (animating && now - lastDraw > 32) { lastDraw = now; network.redraw(); }
      if (now - lastLabel > 250) { lastLabel = now; label(); }
      requestAnimationFrame(frame);
    }

    // Connect once the layout has settled: a replay played over a graph that
    // is still arranging itself would be wasted.
    var connected = false;
    function connect() {
      if (connected) return;
      connected = true;
      pulseConnect(
        function (info) { if (pill) pill.hidden = false; state = "connecting"; label(); requestAnimationFrame(frame); },
        onEvent,
        function (next) { state = next; label(); }
      );
    }
    network.once("stabilizationIterationsDone", connect);
    setTimeout(connect, 8000);
  })();
`;
/** Atlas index: the card of whichever directory is executing lights up. */
export const PULSE_INDEX_JS = `${PULSE_CONNECT_JS}
  (function () {
    var pill = document.getElementById("pulse"), pillText = document.getElementById("pulse-text");
    var cards = Array.prototype.slice.call(document.querySelectorAll("a.card[data-scope]"));
    var timers = [], state = "", lastActivity = 0, currentFile = "";

    function cardFor(file) {
      var best = null, bestLength = -1;
      cards.forEach(function (card, i) {
        var scope = card.getAttribute("data-scope");
        if (scope && file.indexOf(scope + "/") === 0 && scope.length > bestLength) { best = i; bestLength = scope.length; }
      });
      return best;
    }

    function onEvent(ev) {
      (ev.a || []).forEach(function (chain) {
        lastActivity = performance.now();
        currentFile = chain[chain.length - 1];
        var i = cardFor(currentFile);
        if (i === null) return;
        cards[i].classList.add("hot");
        clearTimeout(timers[i]);
        timers[i] = setTimeout(function () { cards[i].classList.remove("hot"); }, 450);
      });
    }

    function label() {
      if (!pill) return;
      var idle = performance.now() - lastActivity > 1200;
      pillText.textContent = state !== "live" ? state : idle || !currentFile ? "live, waiting" : "live in " + currentFile;
      pill.className = "pulse" + (state === "live" && !idle ? " busy" : "");
    }

    pulseConnect(
      function () { if (pill) pill.hidden = false; state = "connecting"; label(); setInterval(label, 250); },
      onEvent,
      function (next) { state = next; label(); }
    );
  })();
`;
/** Status pill shared by both page types. */
export const PULSE_PILL_HTML = `<span id="pulse" class="pulse" hidden><i></i><span id="pulse-text">pulse</span></span>`;
export const PULSE_CSS = `
  .pulse { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-2); min-width: 0; }
  .pulse span { max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pulse[hidden] { display: none; }
  .pulse i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .pulse.busy i { background: var(--good); box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 28%, transparent); }
`;
