const shieldThreadState = {
  report: null,
  allowed: false,
  progress: 18,
  game: null
};

function shieldThreadIsGoogleSearchPage() {
  const host = location.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "google.com" && !host.endsWith(".google.com")) return false;

  const path = location.pathname.toLowerCase();
  const params = new URLSearchParams(location.search);
  if (host === "google.com" && ["/", "/search", "/webhp", "/imghp", "/url"].includes(path)) return true;
  return ["/search", "/url"].includes(path) || (path === "/" && params.has("q"));
}

function shieldThreadShouldSkipWebsiteGate() {
  return shieldThreadIsGoogleSearchPage();
}

function shieldThreadAskWebsiteGateDecision() {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      resolve({ shouldGate: true, reason: "runtime-unavailable" });
      return;
    }

    chrome.runtime.sendMessage({ type: "SHOULD_GATE_WEBSITE", payload: { url: location.href } }, (decision) => {
      if (chrome.runtime.lastError) {
        resolve({ shouldGate: true, reason: "runtime-error" });
        return;
      }
      resolve(decision || { shouldGate: true, reason: "missing-decision" });
    });
  });
}

function shieldThreadCollectPage() {
  const links = [...document.links].map((link) => ({
    href: link.href,
    text: link.innerText || link.textContent || link.getAttribute("aria-label") || link.href
  }));
  const attachments = links
    .map((link) => link.href)
    .filter((href) => /\.(pdf|docx?|xlsx?|pptx?|zip|exe|js|scr|msi|docm|xlsm|html?)(\?|#|$)/i.test(href));
  const forms = [...document.forms].map((form) => ({
    action: form.action || location.href,
    method: form.method || "get",
    hasPassword: Boolean(form.querySelector("input[type='password']")),
    inputNames: [...form.querySelectorAll("input, textarea, select")]
      .map((input) => input.name || input.id || input.type || "")
      .filter(Boolean)
      .slice(0, 20)
  }));
  const text = document.body ? document.body.innerText.slice(0, 22000) : document.title;

  return {
    surface: "website",
    title: document.title || location.hostname,
    url: location.href,
    text,
    links,
    attachments,
    forms
  };
}

function shieldThreadBuildGate() {
  const gate = document.createElement("section");
  gate.className = "shieldthread-gate";
  gate.innerHTML = `
    <main class="shieldthread-gate-main">
      <div class="shieldthread-wait-card">
        <div class="shieldthread-mark">ST</div>
        <h1>ShieldThread is checking this page</h1>
        <p>Scanning visible content, links, forms, and downloadable files before this site can touch your data.</p>

        <div class="shieldthread-game" tabindex="0">
          <div class="shieldthread-game-head">
            <span>Patch Runner</span>
            <div class="shieldthread-game-stats">
              <b>Score <span id="shieldthread-score">0</span></b>
              <b>Lives <span id="shieldthread-lives">3</span></b>
            </div>
          </div>
          <canvas id="shieldthread-game-canvas" class="shieldthread-canvas" width="720" height="300" aria-label="Patch Runner game"></canvas>
          <div class="shieldthread-game-help">
            <span>Move with WASD or arrows</span>
            <span>Space clears nearby phish hooks</span>
          </div>
        </div>

        <div class="shieldthread-ad-slot shieldthread-ad-slot-main" aria-label="Advertisement placeholder">
          <span>Ad</span>
          <strong>Sponsored security tip</strong>
          <p>Place a privacy-safe sponsor here while the scan runs. Never target ads from email or document content.</p>
        </div>

        <div class="shieldthread-progress">
          <div class="shieldthread-progress-labels">
            <span>Scanning page, links, forms, and downloads...</span>
            <b id="shieldthread-progress-label">18%</b>
          </div>
          <div class="shieldthread-progress-track"><div class="shieldthread-progress-fill" id="shieldthread-progress-fill"></div></div>
        </div>
      </div>
    </main>
    <aside class="shieldthread-rail">
      <div class="shieldthread-report-title"><h2>ShieldThread Risk Report</h2></div>
      <div class="shieldthread-finding"><strong>Scan in progress</strong><p>Report will appear when the first-pass analysis finishes.</p></div>
      <div class="shieldthread-ad-slot shieldthread-ad-slot-rail" aria-label="Advertisement placeholder">
        <span>Ad</span>
        <strong>Security sponsor slot</strong>
        <p>Use broad contextual sponsorship only. Disable it for dangerous reports.</p>
      </div>
    </aside>
  `;

  document.documentElement.appendChild(gate);
  shieldThreadStartGame(gate.querySelector("#shieldthread-game-canvas"));
  gate.querySelector(".shieldthread-game")?.focus({ preventScroll: true });
  return gate;
}

function shieldThreadStartGame(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const game = {
    canvas,
    ctx,
    dpr: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
    width: 720,
    height: 300,
    player: { x: 96, y: 150, r: 16, vx: 0, vy: 0, pulse: 0 },
    packets: [],
    threats: [],
    sparks: [],
    keys: new Set(),
    score: 0,
    lives: 3,
    frame: 0,
    last: 0,
    raf: 0,
    spawnTimer: 0,
    packetTimer: 0,
    pulseCooldown: 0
  };
  game.reducedMotion = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  shieldThreadState.game = game;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    game.width = rect.width || 720;
    game.height = rect.height || 300;
    canvas.width = Math.floor(game.width * game.dpr);
    canvas.height = Math.floor(game.height * game.dpr);
    ctx.setTransform(game.dpr, 0, 0, game.dpr, 0, 0);
  }

  function spawnThreat() {
    game.threats.push({
      x: game.width + 24,
      y: 42 + Math.random() * (game.height - 92),
      r: 14 + Math.random() * 6,
      vx: 1.5 + Math.random() * 1.3,
      label: Math.random() > 0.5 ? "phish" : "spoof"
    });
  }

  function spawnPacket() {
    game.packets.push({
      x: game.width + 20,
      y: 40 + Math.random() * (game.height - 80),
      r: 9,
      vx: 1.2 + Math.random() * 0.8
    });
  }

  function drawRoundedRect(x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function circleHit(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy) < a.r + b.r;
  }

  function addSpark(x, y, color) {
    for (let i = 0; i < 8; i += 1) {
      game.sparks.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 5,
        vy: (Math.random() - 0.5) * 5,
        life: 28,
        color
      });
    }
  }

  function updateHud() {
    const score = document.getElementById("shieldthread-score");
    const lives = document.getElementById("shieldthread-lives");
    if (score) score.textContent = String(game.score);
    if (lives) lives.textContent = String(game.lives);
  }

  function update(delta) {
    const speed = 0.36 * delta;
    const player = game.player;
    player.vx = 0;
    player.vy = 0;
    if (game.keys.has("arrowleft") || game.keys.has("a")) player.vx -= speed;
    if (game.keys.has("arrowright") || game.keys.has("d")) player.vx += speed;
    if (game.keys.has("arrowup") || game.keys.has("w")) player.vy -= speed;
    if (game.keys.has("arrowdown") || game.keys.has("s")) player.vy += speed;
    player.x = Math.max(24, Math.min(game.width - 24, player.x + player.vx));
    player.y = Math.max(32, Math.min(game.height - 32, player.y + player.vy));

    game.spawnTimer -= delta;
    game.packetTimer -= delta;
    game.pulseCooldown = Math.max(0, game.pulseCooldown - delta);
    player.pulse = Math.max(0, player.pulse - delta);
    if (game.spawnTimer <= 0) {
      spawnThreat();
      game.spawnTimer = 720 + Math.random() * 560;
    }
    if (game.packetTimer <= 0) {
      spawnPacket();
      game.packetTimer = 580 + Math.random() * 620;
    }

    game.threats.forEach((threat) => {
      threat.x -= threat.vx * (delta / 16);
      threat.y += Math.sin((game.frame + threat.x) / 28) * 0.45;
      if (player.pulse > 0) {
        const dx = threat.x - player.x;
        const dy = threat.y - player.y;
        const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        if (distance < 92) {
          threat.x += (dx / distance) * 3.2;
          threat.y += (dy / distance) * 3.2;
        }
      }
    });

    game.packets.forEach((packet) => {
      packet.x -= packet.vx * (delta / 16);
    });

    game.threats = game.threats.filter((threat) => {
      if (circleHit(player, threat)) {
        game.lives = Math.max(0, game.lives - 1);
        addSpark(threat.x, threat.y, "#dc2626");
        updateHud();
        return false;
      }
      return threat.x > -40;
    });

    game.packets = game.packets.filter((packet) => {
      if (circleHit(player, packet)) {
        game.score += 25;
        addSpark(packet.x, packet.y, "#15803d");
        updateHud();
        return false;
      }
      return packet.x > -30;
    });

    game.sparks.forEach((spark) => {
      spark.x += spark.vx;
      spark.y += spark.vy;
      spark.life -= 1;
    });
    game.sparks = game.sparks.filter((spark) => spark.life > 0);

    if (game.lives === 0) {
      game.score = Math.max(0, game.score - 1);
      if (game.frame % 90 === 0) game.lives = 3;
      updateHud();
    }
  }

  function render() {
    const { width, height } = game;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "#dde5ee";
    ctx.lineWidth = 1;
    for (let x = (game.frame % 40) - 40; x < width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    ctx.fillStyle = "#e8f3ee";
    drawRoundedRect(18, 24, 150, height - 48, 14);
    ctx.fill();
    ctx.fillStyle = "#475569";
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.fillText("Protected zone", 36, 48);

    game.packets.forEach((packet) => {
      ctx.fillStyle = "#16a34a";
      drawRoundedRect(packet.x - 9, packet.y - 7, 18, 14, 4);
      ctx.fill();
      ctx.fillStyle = "#dcfce7";
      ctx.fillRect(packet.x - 4, packet.y - 2, 8, 3);
    });

    game.threats.forEach((threat) => {
      ctx.fillStyle = "#fee2e2";
      ctx.beginPath();
      ctx.arc(threat.x, threat.y, threat.r + 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(threat.x, threat.y, threat.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#991b1b";
      ctx.font = "10px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("!", threat.x, threat.y + 4);
    });
    ctx.textAlign = "left";

    const player = game.player;
    if (player.pulse > 0) {
      ctx.strokeStyle = "rgba(21, 128, 61, 0.28)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(player.x, player.y, 76 - player.pulse * 0.05, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = "#dcfce7";
    ctx.strokeStyle = "#15803d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(player.x, player.y - 22);
    ctx.lineTo(player.x + 20, player.y - 10);
    ctx.lineTo(player.x + 16, player.y + 18);
    ctx.lineTo(player.x, player.y + 26);
    ctx.lineTo(player.x - 16, player.y + 18);
    ctx.lineTo(player.x - 20, player.y - 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#14532d";
    ctx.font = "bold 13px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ST", player.x, player.y + 5);
    ctx.textAlign = "left";

    game.sparks.forEach((spark) => {
      ctx.globalAlpha = Math.max(0, spark.life / 28);
      ctx.fillStyle = spark.color;
      ctx.fillRect(spark.x, spark.y, 3, 3);
      ctx.globalAlpha = 1;
    });

    if (game.lives === 0) {
      ctx.fillStyle = "rgba(15, 23, 42, 0.72)";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Shield rebooting...", width / 2, height / 2);
      ctx.textAlign = "left";
    }
  }

  function loop(timestamp) {
    const delta = game.last ? Math.min(34, timestamp - game.last) : 16;
    game.last = timestamp;
    game.frame += 1;
    update(delta);
    render();
    game.raf = requestAnimationFrame(loop);
  }

  function normalizeGameKey(event) {
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "").toLowerCase();
    if (key === " " || key === "spacebar" || code === "space") return "space";
    if (code.startsWith("key")) return code.slice(3);
    if (code.startsWith("arrow")) return code;
    return key;
  }

  function isTypingTarget(target) {
    return target?.closest?.("input, textarea, select, [contenteditable='true']");
  }

  function keydown(event) {
    if (isTypingTarget(event.target)) return;
    const key = normalizeGameKey(event);
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "a", "d", "w", "s", "space"].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (key === "space" && game.pulseCooldown === 0) {
        game.player.pulse = 420;
        game.pulseCooldown = 900;
        addSpark(game.player.x, game.player.y, "#15803d");
      } else if (key !== "space") {
        game.keys.add(key);
      }
      if (game.reducedMotion) {
        update(16);
        render();
      }
    }
  }

  function keyup(event) {
    if (isTypingTarget(event.target)) return;
    const key = normalizeGameKey(event);
    game.keys.delete(key);
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "a", "d", "w", "s", "space"].includes(key)) {
      event.stopPropagation();
    }
    if (game.reducedMotion) render();
  }

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keyup", keyup, true);
  game.cleanup = () => {
    if (game.raf) cancelAnimationFrame(game.raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("keyup", keyup, true);
  };
  updateHud();
  if (game.reducedMotion) {
    spawnThreat();
    spawnPacket();
    game.spawnTimer = Number.POSITIVE_INFINITY;
    game.packetTimer = Number.POSITIVE_INFINITY;
    render();
  } else {
    game.raf = requestAnimationFrame(loop);
  }
}

function shieldThreadStopGame() {
  if (shieldThreadState.game?.cleanup) shieldThreadState.game.cleanup();
  shieldThreadState.game = null;
}

function shieldThreadUpdateProgress(value) {
  shieldThreadState.progress = value;
  const label = document.getElementById("shieldthread-progress-label");
  const fill = document.getElementById("shieldthread-progress-fill");
  if (label) label.textContent = `${value}%`;
  if (fill) fill.style.width = `${value}%`;
}

function shieldThreadRenderGateReport(gate, report) {
  const rail = gate.querySelector(".shieldthread-rail");
  rail.replaceWith(shieldThreadCreateReport(report));

  const activeRail = gate.querySelector(".shieldthread-rail");
  const actions = document.createElement("div");
  actions.className = "shieldthread-actions";
  if (report.level === "safe") {
    actions.innerHTML = `<button class="shieldthread-button" type="button">Continue</button>`;
  } else {
    actions.innerHTML = `
      <input class="shieldthread-input" aria-label="Confirmation keyword" placeholder="Type ${report.confirmationKeyword}">
      <button class="shieldthread-button" type="button">Continue Anyway</button>
      <button class="shieldthread-button secondary" type="button">Go Back</button>
    `;
  }

  activeRail.appendChild(actions);
  if (report.level !== "dangerous") {
    const ad = document.createElement("div");
    ad.className = "shieldthread-ad-slot shieldthread-ad-slot-rail";
    ad.innerHTML = `<span>Ad</span><strong>Privacy-safe sponsor slot</strong><p>Shown only when the report is not high risk.</p>`;
    activeRail.appendChild(ad);
  }

  const [primary, secondary] = actions.querySelectorAll("button");
  primary.addEventListener("click", () => {
    const input = actions.querySelector("input");
    if (input && input.value.trim().toUpperCase() !== report.confirmationKeyword) {
      input.focus();
      input.style.borderColor = "#dc2626";
      return;
    }
    shieldThreadStopGame();
    gate.remove();
    shieldThreadState.allowed = true;
  });

  if (secondary) {
    secondary.addEventListener("click", () => {
      shieldThreadStopGame();
      history.length > 1 ? history.back() : location.assign("about:blank");
    });
  }
}

function shieldThreadRunWebsiteGate() {
  const gate = shieldThreadBuildGate();
  const timer = setInterval(() => {
    if (shieldThreadState.progress < 86) shieldThreadUpdateProgress(shieldThreadState.progress + 9);
  }, 280);

  const runScan = () => {
    chrome.runtime.sendMessage({ type: "SCAN_SURFACE", payload: shieldThreadCollectPage() }, (report) => {
      clearInterval(timer);
      shieldThreadUpdateProgress(100);
      shieldThreadState.report = report;
      setTimeout(() => shieldThreadRenderGateReport(gate, report), 360);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runScan, { once: true });
  } else {
    runScan();
  }
}

function shieldThreadStart() {
  if (window.top !== window || location.protocol === "chrome-extension:" || shieldThreadShouldSkipWebsiteGate()) return;

  shieldThreadAskWebsiteGateDecision().then((decision) => {
    if (!decision?.shouldGate || shieldThreadShouldSkipWebsiteGate()) return;
    shieldThreadRunWebsiteGate();
  });
}

shieldThreadStart();
