const veyraState = {
  report: null,
  allowed: false,
  progress: 18,
  game: null
};

function veyraIsGoogleSearchPage() {
  const host = location.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "google.com" && !host.endsWith(".google.com")) return false;

  const path = location.pathname.toLowerCase();
  const params = new URLSearchParams(location.search);
  if (host === "google.com" && ["/", "/search", "/webhp", "/imghp", "/url"].includes(path)) return true;
  return ["/search", "/url"].includes(path) || (path === "/" && params.has("q"));
}

function veyraShouldSkipWebsiteGate() {
  return veyraIsGoogleSearchPage();
}

function veyraAskWebsiteGateDecision() {
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

function veyraCollectPage() {
  const currentHost = location.hostname.replace(/^www\./, "").toLowerCase();
  const links = [...document.links].map((link) => ({
    href: link.href,
    text: link.innerText || link.textContent || link.getAttribute("aria-label") || link.href
  }));
  const linkHosts = links.map((link) => {
    try {
      return new URL(link.href).hostname.replace(/^www\./, "").toLowerCase();
    } catch (_error) {
      return "";
    }
  }).filter(Boolean);
  const scriptHosts = [...document.scripts].map((script) => {
    try {
      return script.src ? new URL(script.src).hostname.replace(/^www\./, "").toLowerCase() : "";
    } catch (_error) {
      return "";
    }
  }).filter(Boolean);
  const attachments = links
    .map((link) => link.href)
    .filter((href) => /\.(pdf|docx?|xlsx?|pptx?|zip|exe|js|scr|msi|docm|xlsm|html?)(\?|#|$)/i.test(href));
  const forms = [...document.forms].map((form) => ({
    action: form.action || location.href,
    method: form.method || "get",
    hasPassword: Boolean(form.querySelector("input[type='password']")),
    hiddenCount: form.querySelectorAll("input[type='hidden']").length,
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
    forms,
    externalHostCount: new Set(linkHosts.filter((host) => host && host !== currentHost)).size,
    scriptHostCount: new Set(scriptHosts.filter((host) => host && host !== currentHost)).size,
    iframeCount: document.querySelectorAll("iframe").length
  };
}

function veyraBuildGate() {
  const gate = document.createElement("section");
  gate.className = "veyra-gate";
  gate.innerHTML = `
    <main class="veyra-gate-main">
      <div class="veyra-wait-card">
        <div class="veyra-arcade-top">
          <div class="veyra-mark">ST</div>
          <div>
            <span class="veyra-kicker">Website protection</span>
            <h1>Checking this site before data leaves your browser</h1>
          </div>
        </div>
        <p>Veyra is reviewing page content, forms, outbound links, scripts, and downloads.</p>

        <div class="veyra-scan-grid" aria-hidden="true">
          <span>URL</span>
          <span>DOM</span>
          <span>LINKS</span>
          <span>FILES</span>
        </div>

        <div class="veyra-game" tabindex="0">
          <div class="veyra-game-head">
            <span>Sky Check Runner</span>
            <div class="veyra-game-stats">
              <b>Distance <span id="veyra-score">0</span></b>
              <b>Shield <span id="veyra-lives">3</span></b>
            </div>
          </div>
          <div class="veyra-game-stage">
            <canvas id="veyra-game-canvas" class="veyra-canvas" width="720" height="300" aria-label="Sky Check Runner game"></canvas>
          </div>
          <div class="veyra-game-help">
            <span>Clean packets collected</span>
            <span>Jump runner active</span>
          </div>
        </div>

        <div class="veyra-ad-slot veyra-ad-slot-main" aria-label="Advertisement placeholder">
          <span>Ad</span>
          <strong>Privacy-safe sponsor board</strong>
          <p>Broad security sponsorship only. No ad targeting from page contents.</p>
        </div>

        <div class="veyra-progress">
          <div class="veyra-progress-labels">
            <span>Analysis in progress</span>
            <b id="veyra-progress-label">18%</b>
          </div>
          <div class="veyra-progress-track"><div class="veyra-progress-fill" id="veyra-progress-fill"></div></div>
        </div>
      </div>
    </main>
    <aside class="veyra-rail">
      <div class="veyra-report-title"><h2>Veyra Risk Report</h2></div>
      <div class="veyra-finding"><strong>Scan in progress</strong><p>Awaiting first-pass risk report.</p></div>
      <div class="veyra-ad-slot veyra-ad-slot-rail" aria-label="Advertisement placeholder">
        <span>Ad</span>
        <strong>Security sponsor slot</strong>
        <p>Disabled on dangerous reports.</p>
      </div>
    </aside>
  `;

  document.documentElement.appendChild(gate);
  veyraStartGame(gate.querySelector("#veyra-game-canvas"));
  gate.querySelector(".veyra-game")?.focus({ preventScroll: true });
  return gate;
}

function veyraStartGame(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const game = {
    canvas,
    ctx,
    dpr: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
    width: 720,
    height: 300,
    player: { x: 96, y: 0, width: 34, height: 42, vy: 0, grounded: true, squash: 0 },
    packets: [],
    threats: [],
    clouds: [],
    sparks: [],
    keys: new Set(),
    score: 0,
    lives: 3,
    frame: 0,
    last: 0,
    raf: 0,
    spawnTimer: 0,
    packetTimer: 0,
    cloudTimer: 0,
    groundY: 244,
    speed: 3.1
  };
  game.reducedMotion = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  veyraState.game = game;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    game.width = rect.width || 720;
    game.height = rect.height || 300;
    game.groundY = Math.max(180, game.height - 58);
    if (game.player.grounded) game.player.y = game.groundY - game.player.height;
    canvas.width = Math.floor(game.width * game.dpr);
    canvas.height = Math.floor(game.height * game.dpr);
    ctx.setTransform(game.dpr, 0, 0, game.dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }

  function spawnThreat() {
    game.threats.push({
      x: game.width + 28,
      y: game.groundY - 34,
      width: 24 + Math.random() * 16,
      height: 30 + Math.random() * 16,
      vx: game.speed + Math.random() * 0.8,
      label: Math.random() > 0.5 ? "phish" : "spoof"
    });
  }

  function spawnPacket() {
    game.packets.push({
      x: game.width + 20,
      y: game.groundY - 92 - Math.random() * 58,
      r: 10,
      vx: game.speed
    });
  }

  function spawnCloud() {
    game.clouds.push({
      x: game.width + 70,
      y: 32 + Math.random() * 72,
      scale: 0.8 + Math.random() * 0.8,
      vx: 0.45 + Math.random() * 0.35
    });
  }

  function drawRoundedRect(x, y, width, height, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
  }

  function rectHit(a, b) {
    return a.x < b.x + b.width
      && a.x + a.width > b.x
      && a.y < b.y + b.height
      && a.y + a.height > b.y;
  }

  function jump() {
    const player = game.player;
    if (!player.grounded) return;
    player.vy = -12.8;
    player.grounded = false;
    player.squash = 8;
    addSpark(player.x + player.width / 2, game.groundY, "#38bdf8");
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
    const score = document.getElementById("veyra-score");
    const lives = document.getElementById("veyra-lives");
    if (score) score.textContent = String(game.score);
    if (lives) lives.textContent = String(game.lives);
  }

  function update(delta) {
    const scale = delta / 16;
    const player = game.player;
    if (game.keys.has("arrowup") || game.keys.has("w") || game.keys.has("space")) jump();

    player.vy += 0.72 * scale;
    player.y += player.vy * scale;
    player.squash = Math.max(0, player.squash - delta * 0.08);
    if (player.y >= game.groundY - player.height) {
      player.y = game.groundY - player.height;
      player.vy = 0;
      player.grounded = true;
    }

    game.spawnTimer -= delta;
    game.packetTimer -= delta;
    game.cloudTimer -= delta;
    game.speed = Math.min(5.8, game.speed + delta * 0.0009);
    if (game.spawnTimer <= 0) {
      spawnThreat();
      game.spawnTimer = 880 + Math.random() * 680;
    }
    if (game.packetTimer <= 0) {
      spawnPacket();
      game.packetTimer = 720 + Math.random() * 720;
    }
    if (game.cloudTimer <= 0) {
      spawnCloud();
      game.cloudTimer = 1200 + Math.random() * 1200;
    }

    game.threats.forEach((threat) => {
      threat.x -= threat.vx * scale;
    });

    game.packets.forEach((packet) => {
      packet.x -= packet.vx * scale;
      packet.y += Math.sin((game.frame + packet.x) / 18) * 0.35;
    });

    game.clouds.forEach((cloud) => {
      cloud.x -= cloud.vx * scale;
    });

    const playerBox = { x: player.x + 5, y: player.y + 4, width: player.width - 10, height: player.height - 6 };
    game.threats = game.threats.filter((threat) => {
      if (rectHit(playerBox, threat)) {
        game.lives = Math.max(0, game.lives - 1);
        addSpark(threat.x + threat.width / 2, threat.y + threat.height / 2, "#ef4444");
        updateHud();
        return false;
      }
      return threat.x > -40;
    });

    game.packets = game.packets.filter((packet) => {
      const packetBox = { x: packet.x - packet.r, y: packet.y - packet.r, width: packet.r * 2, height: packet.r * 2 };
      if (rectHit(playerBox, packetBox)) {
        game.score += 25;
        addSpark(packet.x, packet.y, "#0ea5e9");
        updateHud();
        return false;
      }
      return packet.x > -30;
    });
    game.clouds = game.clouds.filter((cloud) => cloud.x > -130);

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
    } else if (game.frame % 8 === 0) {
      game.score += 1;
      updateHud();
    }
  }

  function render() {
    const { width, height } = game;
    ctx.clearRect(0, 0, width, height);
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#e0f2fe");
    sky.addColorStop(0.62, "#f8fbff");
    sky.addColorStop(1, "#ffffff");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    game.clouds.forEach((cloud) => {
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.beginPath();
      ctx.ellipse(cloud.x, cloud.y, 38 * cloud.scale, 14 * cloud.scale, 0, 0, Math.PI * 2);
      ctx.ellipse(cloud.x + 26 * cloud.scale, cloud.y + 2, 30 * cloud.scale, 12 * cloud.scale, 0, 0, Math.PI * 2);
      ctx.ellipse(cloud.x - 22 * cloud.scale, cloud.y + 4, 24 * cloud.scale, 10 * cloud.scale, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    drawRoundedRect(0, game.groundY, width, height - game.groundY, 0, "#dbeafe");
    ctx.strokeStyle = "#93c5fd";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, game.groundY + 1);
    ctx.lineTo(width, game.groundY + 1);
    ctx.stroke();
    for (let x = -((game.frame * game.speed) % 44); x < width; x += 44) {
      drawRoundedRect(x, game.groundY + 20, 24, 4, 2, "#bfdbfe");
    }

    game.packets.forEach((packet) => {
      ctx.fillStyle = "#0ea5e9";
      ctx.beginPath();
      ctx.arc(packet.x, packet.y, packet.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(packet.x - 3, packet.y - 3, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    game.threats.forEach((threat) => {
      drawRoundedRect(threat.x, threat.y, threat.width, threat.height, 8, "#fecaca");
      drawRoundedRect(threat.x + 5, threat.y + 5, threat.width - 10, threat.height - 10, 6, "#ef4444");
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 14px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("!", threat.x + threat.width / 2, threat.y + threat.height / 2 + 5);
    });
    ctx.textAlign = "left";

    const player = game.player;
    const squash = player.squash;
    drawRoundedRect(player.x, player.y + squash, player.width, player.height - squash, 10, "#2563eb");
    drawRoundedRect(player.x + 6, player.y - 14 + squash, player.width - 12, 18, 9, "#60a5fa");
    drawRoundedRect(player.x + 4, player.y + player.height - 4, 12, 8, 4, "#1d4ed8");
    drawRoundedRect(player.x + player.width - 16, player.y + player.height - 4, 12, 8, 4, "#1d4ed8");
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(player.x + 22, player.y - 5 + squash, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1e3a8a";
    ctx.font = "bold 11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ST", player.x + player.width / 2, player.y + 27);
    ctx.textAlign = "left";

    game.sparks.forEach((spark) => {
      ctx.globalAlpha = Math.max(0, spark.life / 28);
      drawRoundedRect(spark.x, spark.y, 4, 4, 2, spark.color);
      ctx.globalAlpha = 1;
    });

    if (game.lives === 0) {
      ctx.fillStyle = "rgba(15, 23, 42, 0.62)";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 18px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Shield refreshing", width / 2, height / 2);
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
      game.keys.add(key);
      if (key === "space" || key === "arrowup" || key === "w") jump();
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

function veyraStopGame() {
  if (veyraState.game?.cleanup) veyraState.game.cleanup();
  veyraState.game = null;
}

function veyraUpdateProgress(value) {
  veyraState.progress = value;
  const label = document.getElementById("veyra-progress-label");
  const fill = document.getElementById("veyra-progress-fill");
  if (label) label.textContent = `${value}%`;
  if (fill) fill.style.width = `${value}%`;
}

function veyraRenderGateReport(gate, report) {
  const rail = gate.querySelector(".veyra-rail");
  rail.replaceWith(veyraCreateReport(report));

  const activeRail = gate.querySelector(".veyra-rail");
  const actions = document.createElement("div");
  actions.className = "veyra-actions";
  if (report.level === "safe") {
    actions.innerHTML = `<button class="veyra-button" type="button">Continue</button>`;
  } else {
    actions.innerHTML = `
      <input class="veyra-input" aria-label="Confirmation keyword" placeholder="Type ${report.confirmationKeyword}">
      <button class="veyra-button" type="button">Continue Anyway</button>
      <button class="veyra-button secondary" type="button">Go Back</button>
    `;
  }

  activeRail.appendChild(actions);
  if (report.level !== "dangerous") {
    const ad = document.createElement("div");
    ad.className = "veyra-ad-slot veyra-ad-slot-rail";
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
    veyraStopGame();
    gate.remove();
    veyraState.allowed = true;
  });

  if (secondary) {
    secondary.addEventListener("click", () => {
      veyraStopGame();
      history.length > 1 ? history.back() : location.assign("about:blank");
    });
  }
}

function veyraRunWebsiteGate() {
  const gate = veyraBuildGate();
  const timer = setInterval(() => {
    if (veyraState.progress < 86) veyraUpdateProgress(veyraState.progress + 9);
  }, 280);

  const runScan = () => {
    chrome.runtime.sendMessage({ type: "SCAN_SURFACE", payload: veyraCollectPage() }, (report) => {
      clearInterval(timer);
      veyraUpdateProgress(100);
      veyraState.report = report;
      setTimeout(() => veyraRenderGateReport(gate, report), 360);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runScan, { once: true });
  } else {
    runScan();
  }
}

function veyraStart() {
  if (window.top !== window || location.protocol === "chrome-extension:" || veyraShouldSkipWebsiteGate()) return;

  veyraAskWebsiteGateDecision().then((decision) => {
    if (!decision?.shouldGate || veyraShouldSkipWebsiteGate()) return;
    veyraRunWebsiteGate();
  });
}

veyraStart();
