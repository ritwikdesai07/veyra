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
          <div class="veyra-mark">VY</div>
          <div>
            <span class="veyra-kicker">Scanning in progress</span>
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
            <span>Checkpoint Run</span>
            <div class="veyra-game-stats">
              <b>Score <span id="veyra-score">0</span></b>
              <b>Lives <span id="veyra-lives">3</span></b>
            </div>
          </div>
          <div class="veyra-game-stage">
            <canvas id="veyra-game-canvas" class="veyra-canvas" width="720" height="300" aria-label="Checkpoint Run side scrolling platform game"></canvas>
          </div>
          <div class="veyra-game-help">
            <span>Arrow keys or A/D to move</span>
            <span>Up, W, or Space to jump</span>
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
      <div class="veyra-report-title"><h2>Risk report</h2></div>
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

// ---- Level data -----------------------------------------------------------
// A small hand-built platforming level. Coordinates are in world units;
// the camera scrolls horizontally to follow the player. Platform y-values
// are measured upward from the ground line.
const VEYRA_LEVEL_WIDTH = 2400;
const VEYRA_GROUND_Y = 244; // reference ground y at design height 300

const VEYRA_START_PLATFORM_H = 56;

function veyraBuildLevel() {
  const pits = [
    { x: 520, w: 72 },
    { x: 1280, w: 88 },
    { x: 1910, w: 78 }
  ];

  const floorSpan = (from, to) => ({ x: from, y: 0, w: to - from, h: VEYRA_START_PLATFORM_H });
  const floorSegments = [];
  let cursor = 0;
  pits.forEach((pit) => {
    if (pit.x > cursor) floorSegments.push(floorSpan(cursor, pit.x));
    cursor = pit.x + pit.w;
  });
  floorSegments.push(floorSpan(cursor, VEYRA_LEVEL_WIDTH));

  const elevated = [
    { x: 210, y: 56, w: 34, h: 28 }, { x: 244, y: 56, w: 34, h: 56 }, { x: 278, y: 56, w: 34, h: 84 },
    { x: 312, y: 56, w: 34, h: 112 }, { x: 346, y: 56, w: 34, h: 140 },
    { x: 690, y: 96, w: 108, h: 18 },
    { x: 835, y: 138, w: 96, h: 18 },
    { x: 1120, y: 102, w: 118, h: 18 },
    { x: 1450, y: 118, w: 92, h: 18 },
    { x: 1610, y: 146, w: 112, h: 18 },
    { x: 1980, y: 108, w: 120, h: 18 }
  ];

  const platforms = [...floorSegments, ...elevated];
  const hazards = [
    { x: 1010, y: 0, w: 26, h: 24, type: "enemy" },
    { x: 1515, y: 0, w: 26, h: 24, type: "enemy" },
    { x: 1790, y: 0, w: 26, h: 24, type: "enemy" }
  ];
  const pipes = [
    { x: 610, y: 0, w: 54, h: 92 },
    { x: 1385, y: 0, w: 58, h: 78 }
  ];
  const orbSpots = [
    [248, 134], [282, 162], [316, 190], [350, 218],
    [725, 132], [875, 174], [1165, 138],
    [1490, 154], [1650, 182], [1690, 182],
    [2035, 144], [2075, 144], [2190, 66], [2260, 66]
  ];
  const orbs = orbSpots.map(([x, y], id) => ({ x, y, r: 7, id, collected: false }));

  return { platforms, pits, hazards, pipes, orbs, goalX: VEYRA_LEVEL_WIDTH - 72 };
}

function veyraStartGame(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const level = veyraBuildLevel();
  const game = {
    canvas,
    ctx,
    level,
    dpr: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
    width: 720,
    height: 300,
    scale: 1,
    camX: 0,
    player: { x: 40, y: 0, width: 24, height: 32, vx: 0, vy: 0, grounded: true, facing: 1, squash: 0 },
    spawnX: 40,
    sparks: [],
    keys: new Set(),
    score: 0,
    lives: 3,
    won: false,
    frame: 0,
    last: 0,
    raf: 0,
    groundY: VEYRA_GROUND_Y,
    hurtTimer: 0
  };
  game.player.y = game.groundY - VEYRA_START_PLATFORM_H - game.player.height;
  game.reducedMotion = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  veyraState.game = game;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    game.width = rect.width || 720;
    game.height = rect.height || 300;
    game.scale = game.height / 300;
    canvas.width = Math.floor(game.width * game.dpr);
    canvas.height = Math.floor(game.height * game.dpr);
    ctx.setTransform(game.dpr, 0, 0, game.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function drawRect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function rectHit(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  function platRect(p) {
    return { x: p.x, y: game.groundY - p.y - p.h, width: p.w, height: p.h };
  }

  function addSpark(x, y, color) {
    for (let i = 0; i < 7; i += 1) {
      game.sparks.push({ x, y, vx: (Math.random() - 0.5) * 4.5, vy: (Math.random() - 0.5) * 4.5 - 1, life: 24, color });
    }
  }

  function updateHud() {
    const score = document.getElementById("veyra-score");
    const lives = document.getElementById("veyra-lives");
    if (score) score.textContent = String(game.score);
    if (lives) lives.textContent = String(game.lives);
  }

  function jump() {
    const player = game.player;
    if (!player.grounded || game.won) return;
    player.vy = -11.6;
    player.grounded = false;
    player.squash = 6;
    addSpark(player.x + player.width / 2, player.y + player.height, "#2f6fed");
  }

  function respawn(losesLife) {
    if (losesLife) {
      game.lives = Math.max(0, game.lives - 1);
      updateHud();
    }
    const player = game.player;
    player.x = game.spawnX;
    player.y = game.groundY - VEYRA_START_PLATFORM_H - player.height;
    player.vx = 0;
    player.vy = 0;
    player.grounded = true;
    game.hurtTimer = 40;
    if (game.lives === 0) {
      game.lives = 3;
      game.score = Math.max(0, game.score - 50);
      updateHud();
    }
  }

  function update(delta) {
    const scale = delta / 16;
    const player = game.player;

    if (!game.won) {
      const left = game.keys.has("arrowleft") || game.keys.has("a");
      const right = game.keys.has("arrowright") || game.keys.has("d");
      const accel = 0.85;
      const maxSpeed = 4.3;
      if (left && !right) {
        player.vx = Math.max(-maxSpeed, player.vx - accel * scale);
        player.facing = -1;
      } else if (right && !left) {
        player.vx = Math.min(maxSpeed, player.vx + accel * scale);
        player.facing = 1;
      } else {
        player.vx *= Math.pow(0.78, scale);
        if (Math.abs(player.vx) < 0.05) player.vx = 0;
      }
      if (game.keys.has("arrowup") || game.keys.has("w") || game.keys.has("space")) jump();

      player.vy = Math.min(13, player.vy + 0.62 * scale);
      player.squash = Math.max(0, player.squash - delta * 0.07);

      // Horizontal move + side collisions
      const prevX = player.x;
      player.x = Math.max(6, Math.min(VEYRA_LEVEL_WIDTH - player.width - 6, player.x + player.vx * scale));
      level.platforms.forEach((p) => {
        const r = platRect(p);
        const vertOverlap = player.y + player.height > r.y + 2 && player.y < r.y + r.height - 2;
        if (vertOverlap && rectHit({ x: player.x, y: player.y, width: player.width, height: player.height }, r)) {
          if (prevX + player.width <= r.x + 1) player.x = r.x - player.width;
          else if (prevX >= r.x + r.width - 1) player.x = r.x + r.width;
          player.vx = 0;
        }
      });
      level.pipes.forEach((pipe) => {
        const r = { x: pipe.x, y: game.groundY - pipe.y - pipe.h, width: pipe.w, height: pipe.h };
        const vertOverlap = player.y + player.height > r.y + 2 && player.y < r.y + r.height - 2;
        if (vertOverlap && rectHit({ x: player.x, y: player.y, width: player.width, height: player.height }, r)) {
          if (prevX + player.width <= r.x + 1) player.x = r.x - player.width;
          else if (prevX >= r.x + r.width - 1) player.x = r.x + r.width;
          player.vx = 0;
        }
      });

      // Vertical move + top/bottom collisions
      const prevY = player.y;
      let newY = prevY + player.vy * scale;
      player.grounded = false;
      level.platforms.forEach((p) => {
        const r = platRect(p);
        const horizOverlap = player.x + player.width > r.x && player.x < r.x + r.width;
        if (!horizOverlap) return;
        const prevBottom = prevY + player.height;
        const newBottom = newY + player.height;
        if (player.vy >= 0 && prevBottom <= r.y + 1 && newBottom >= r.y) {
          newY = r.y - player.height;
          player.vy = 0;
          player.grounded = true;
        } else if (player.vy < 0 && prevY >= r.y + r.height - 1 && newY <= r.y + r.height) {
          newY = r.y + r.height;
          player.vy = 0.5;
        }
      });
      level.pipes.forEach((pipe) => {
        const r = { x: pipe.x, y: game.groundY - pipe.y - pipe.h, width: pipe.w, height: pipe.h };
        const horizOverlap = player.x + player.width > r.x && player.x < r.x + r.width;
        if (!horizOverlap) return;
        const prevBottom = prevY + player.height;
        const newBottom = newY + player.height;
        if (player.vy >= 0 && prevBottom <= r.y + 1 && newBottom >= r.y) {
          newY = r.y - player.height;
          player.vy = 0;
          player.grounded = true;
        } else if (player.vy < 0 && prevY >= r.y + r.height - 1 && newY <= r.y + r.height) {
          newY = r.y + r.height;
          player.vy = 0.5;
        }
      });
      player.y = newY;

      // Pit fall
      const onPit = level.pits.some((pit) => player.x + player.width > pit.x && player.x < pit.x + pit.w);
      if (onPit && player.y > game.groundY + 40) respawn(true);

      // Hazards
      const playerBox = { x: player.x + 3, y: player.y + 3, width: player.width - 6, height: player.height - 6 };
      if (game.hurtTimer <= 0) {
        level.hazards.forEach((hz) => {
          const r = { x: hz.x, y: game.groundY - hz.y - hz.h, width: hz.w, height: hz.h };
          if (rectHit(playerBox, r)) {
            addSpark(r.x + r.w / 2, r.y + r.h / 2, "#ff5470");
            respawn(true);
          }
        });
      }

      // Orbs
      level.orbs.forEach((orb) => {
        if (orb.collected) return;
        const r = { x: orb.x - orb.r, y: game.groundY - orb.y - orb.r, width: orb.r * 2, height: orb.r * 2 };
        if (rectHit(playerBox, r)) {
          orb.collected = true;
          game.score += 10;
          addSpark(orb.x, game.groundY - orb.y, "#00b894");
          updateHud();
        }
      });

      // Goal
      if (player.x + player.width >= level.goalX) {
        game.won = true;
        game.score += 100;
        updateHud();
      }

      if (game.hurtTimer > 0) game.hurtTimer -= delta;
    }

    const targetCam = player.x - game.width / (2 * game.scale);
    game.camX += (targetCam - game.camX) * Math.min(1, 0.12 * scale);
    game.camX = Math.max(0, Math.min(VEYRA_LEVEL_WIDTH - game.width / game.scale, game.camX));

    game.sparks.forEach((spark) => {
      spark.x += spark.vx;
      spark.y += spark.vy;
      spark.vy += 0.2;
      spark.life -= 1;
    });
    game.sparks = game.sparks.filter((spark) => spark.life > 0);
  }

  function worldToScreenX(x) {
    return (x - game.camX) * game.scale;
  }
  function toScreenY(y) {
    return y * game.scale;
  }

  function render() {
    const { width, height } = game;
    ctx.clearRect(0, 0, width, height);
    drawRect(0, 0, width, height, "#85d8ff");

    function drawCloud(cx, cy, size) {
      ctx.fillStyle = "#ffffff";
      drawRect(cx, cy + 10 * size, 46 * size, 14 * size, "#ffffff");
      ctx.beginPath();
      ctx.arc(cx + 14 * size, cy + 12 * size, 12 * size, Math.PI, Math.PI * 2);
      ctx.arc(cx + 28 * size, cy + 8 * size, 15 * size, Math.PI, Math.PI * 2);
      ctx.arc(cx + 42 * size, cy + 13 * size, 10 * size, Math.PI, Math.PI * 2);
      ctx.fill();
    }

    function drawHill(cx, baseY, w, h, color, cap) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, baseY);
      ctx.lineTo(cx, baseY - h);
      ctx.lineTo(cx + w / 2, baseY);
      ctx.closePath();
      ctx.fill();
      drawRect(cx - w * 0.08, baseY - h * 0.55, w * 0.16, h * 0.2, cap);
    }

    for (let i = 0; i < 8; i += 1) {
      const sx = i * 260 - ((game.camX * 0.18) % 260);
      drawCloud(sx + 35, 38 + (i % 2) * 28, i % 3 === 0 ? 0.82 : 0.58);
    }

    const hillBase = height * 0.78;
    for (let i = 0; i < 8; i += 1) {
      const sx = i * 330 - ((game.camX * 0.36) % 330);
      drawHill(sx + 130, hillBase, 250, 108, i % 2 ? "#6bd66f" : "#49c765", "#b8f5a5");
    }

    const groundScreenY = toScreenY(game.groundY);
    drawRect(0, groundScreenY, width, height - groundScreenY, "#8f5d36");
    for (let y = groundScreenY; y < height; y += 18 * game.scale) {
      for (let x = -((game.camX * game.scale) % (36 * game.scale)); x < width; x += 36 * game.scale) {
        drawRect(x, y, 34 * game.scale, 16 * game.scale, y === groundScreenY ? "#b86b3d" : "#9d5d35");
        drawRect(x, y, 34 * game.scale, 2 * game.scale, "#e2a66a");
      }
    }

    level.platforms.forEach((p) => {
      const r = platRect(p);
      const sx = worldToScreenX(r.x);
      if (sx + r.width * game.scale < -10 || sx > width + 10) return;
      const sy = toScreenY(r.y);
      drawRect(sx, sy, r.width * game.scale, r.height * game.scale, "#b86b3d");
      drawRect(sx, sy, r.width * game.scale, 4 * game.scale, "#f0b36f");
      const brickW = 17 * game.scale;
      const brickH = 14 * game.scale;
      for (let by = sy + 6 * game.scale; by < sy + r.height * game.scale; by += brickH) {
        for (let bx = sx; bx < sx + r.width * game.scale; bx += brickW) {
          drawRect(bx, by, 1.4 * game.scale, brickH - 2 * game.scale, "#7c4228");
        }
        drawRect(sx, by, r.width * game.scale, 1.2 * game.scale, "#7c4228");
      }
    });

    level.pits.forEach((pit) => {
      const sx = worldToScreenX(pit.x);
      if (sx + pit.w * game.scale < -10 || sx > width + 10) return;
      ctx.clearRect(sx, groundScreenY, pit.w * game.scale, height - groundScreenY);
      drawRect(sx, groundScreenY, pit.w * game.scale, 4 * game.scale, "#4f321f");
    });

    level.pipes.forEach((pipe) => {
      const sx = worldToScreenX(pipe.x);
      if (sx + pipe.w * game.scale < -12 || sx > width + 12) return;
      const sy = toScreenY(game.groundY - pipe.y - pipe.h);
      drawRect(sx, sy + 10 * game.scale, pipe.w * game.scale, (pipe.h - 10) * game.scale, "#16a34a");
      drawRect(sx + 7 * game.scale, sy + 12 * game.scale, 8 * game.scale, (pipe.h - 14) * game.scale, "#7ee787");
      drawRect(sx - 7 * game.scale, sy, (pipe.w + 14) * game.scale, 18 * game.scale, "#22c55e");
      drawRect(sx - 7 * game.scale, sy, (pipe.w + 14) * game.scale, 4 * game.scale, "#bbf7d0");
      drawRect(sx + (pipe.w - 6) * game.scale, sy + 8 * game.scale, 6 * game.scale, (pipe.h - 10) * game.scale, "#15803d");
    });

    level.hazards.forEach((hz) => {
      const wy = game.groundY - hz.y - hz.h;
      const sx = worldToScreenX(hz.x);
      if (sx + hz.w * game.scale < -10 || sx > width + 10) return;
      const sy = toScreenY(wy);
      drawRect(sx, sy + 5 * game.scale, hz.w * game.scale, (hz.h - 5) * game.scale, "#8b451f");
      drawRect(sx + 3 * game.scale, sy, (hz.w - 6) * game.scale, 7 * game.scale, "#a16207");
      drawRect(sx + 5 * game.scale, sy + 8 * game.scale, 4 * game.scale, 4 * game.scale, "#111827");
      drawRect(sx + 17 * game.scale, sy + 8 * game.scale, 4 * game.scale, 4 * game.scale, "#111827");
      drawRect(sx + 3 * game.scale, sy + hz.h * game.scale - 2 * game.scale, 7 * game.scale, 3 * game.scale, "#111827");
      drawRect(sx + 16 * game.scale, sy + hz.h * game.scale - 2 * game.scale, 7 * game.scale, 3 * game.scale, "#111827");
    });

    level.orbs.forEach((orb) => {
      if (orb.collected) return;
      const sx = worldToScreenX(orb.x);
      if (sx < -12 || sx > width + 12) return;
      const sy = toScreenY(game.groundY - orb.y);
      const bob = Math.sin((game.frame + orb.id * 30) / 22) * 3 * game.scale;
      ctx.fillStyle = "#facc15";
      ctx.beginPath();
      ctx.arc(sx, sy + bob, orb.r * game.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#a16207";
      ctx.lineWidth = Math.max(1, 2 * game.scale);
      ctx.stroke();
      ctx.fillStyle = "#fff7ad";
      ctx.beginPath();
      ctx.arc(sx - 2 * game.scale, sy + bob - 2 * game.scale, 2.2 * game.scale, 0, Math.PI * 2);
      ctx.fill();
    });

    const goalSx = worldToScreenX(level.goalX);
    if (goalSx > -20 && goalSx < width + 20) {
      drawRect(goalSx, groundScreenY - 88 * game.scale, 4 * game.scale, 88 * game.scale, "#0f172a");
      drawRect(goalSx + 4 * game.scale, groundScreenY - 88 * game.scale, 32 * game.scale, 22 * game.scale, "#0ea5e9");
      drawRect(goalSx + 8 * game.scale, groundScreenY - 83 * game.scale, 18 * game.scale, 4 * game.scale, "#e0f2fe");
    }

    const player = game.player;
    const flashHurt = game.hurtTimer > 0 && Math.floor(game.frame / 4) % 2 === 0;
    const psx = worldToScreenX(player.x);
    const psy = toScreenY(player.y + player.squash);
    const pw = player.width * game.scale;
    const ph = (player.height - player.squash) * game.scale;
    drawRect(psx + pw * 0.2, psy + ph * 0.45, pw * 0.6, ph * 0.5, flashHurt ? "#fca5a5" : "#1d4ed8");
    drawRect(psx + pw * 0.08, psy + ph * 0.18, pw * 0.84, ph * 0.34, flashHurt ? "#fecaca" : "#ef4444");
    drawRect(psx + pw * 0.18, psy - ph * 0.08, pw * 0.64, ph * 0.28, "#f6c59a");
    drawRect(psx + pw * 0.12, psy - ph * 0.18, pw * 0.72, ph * 0.14, "#dc2626");
    ctx.fillStyle = "#111827";
    const eyeX = player.facing > 0 ? psx + pw * 0.62 : psx + pw * 0.2;
    ctx.beginPath();
    ctx.arc(eyeX, psy - ph * 0.1, Math.max(1.4, 2 * game.scale), 0, Math.PI * 2);
    ctx.fill();

    game.sparks.forEach((spark) => {
      ctx.globalAlpha = Math.max(0, spark.life / 24);
      drawRect(worldToScreenX(spark.x), toScreenY(spark.y), 4 * game.scale, 4 * game.scale, spark.color);
      ctx.globalAlpha = 1;
    });

    if (game.won) {
      ctx.fillStyle = "rgba(11, 18, 32, 0.62)";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.max(14, 18 * game.scale)}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("Scan route cleared", width / 2, height / 2 - 6);
      ctx.font = `${Math.max(11, 13 * game.scale)}px Inter, sans-serif`;
      ctx.fillText(`Score ${game.score}`, width / 2, height / 2 + 16);
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
      input.style.borderColor = "#ff5470";
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
