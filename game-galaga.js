(function () {
  const canvas = document.getElementById("galagaCanvas");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("scoreGalaga");
  const livesEl = document.getElementById("livesGalaga");
  const messageEl = document.getElementById("messageGalaga");
  const startBtn = document.getElementById("startGalaga");
  const pauseBtn = document.getElementById("pauseGalaga");
  const restartBtn = document.getElementById("restartGalaga");
  const container = document.getElementById("game-galaga-area");

  if (!canvas) return;

  const rootStyle = getComputedStyle(document.documentElement);
  const themeColor = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
  const COLORS = {
    player: themeColor("--accent", "#d4af37"),
    bullet: themeColor("--accent-2", "#10b981"),
    enemy: themeColor("--danger", "#ef4444"),
  };

  const W = canvas.width;
  const H = canvas.height;
  const PLAYER_W = 28;
  const PLAYER_H = 16;
  const ENEMY_ROWS = 3;
  const ENEMY_COLS = 6;
  const ENEMY_W = 28;
  const ENEMY_H = 18;
  const ENEMY_GAP = 10;

  let playerX, bullets, enemies, enemyDir, enemyStepDown, score, lives, state, rafHandle, moveDir, fireCooldown, wave;

  function resetEnemies() {
    enemies = [];
    for (let r = 0; r < ENEMY_ROWS; r++) {
      for (let c = 0; c < ENEMY_COLS; c++) {
        enemies.push({
          x: 20 + c * (ENEMY_W + ENEMY_GAP),
          y: 30 + r * (ENEMY_H + ENEMY_GAP),
          alive: true,
        });
      }
    }
    enemyDir = 1;
    enemyStepDown = 0;
  }

  function resetPlayer() {
    playerX = W / 2 - PLAYER_W / 2;
    bullets = [];
  }

  function resetGame() {
    resetEnemies();
    resetPlayer();
    score = 0;
    lives = 3;
    wave = 1;
    state = "idle";
    moveDir = 0;
    fireCooldown = 0;
    scoreEl.textContent = "0";
    livesEl.textContent = "3";
    messageEl.textContent = "Start를 눌러 시작하세요.";
    draw();
  }

  function stopLoop() {
    if (rafHandle !== undefined) {
      cancelAnimationFrame(rafHandle);
      rafHandle = undefined;
    }
  }

  function loop() {
    update();
    draw();
    if (state === "running") {
      rafHandle = requestAnimationFrame(loop);
    }
  }

  function startGame() {
    if (state === "running") return;
    if (state === "gameover" || state === "win") resetGame();
    state = "running";
    messageEl.textContent = "";
    stopLoop();
    rafHandle = requestAnimationFrame(loop);
  }

  function togglePause() {
    if (state === "running") {
      state = "paused";
      stopLoop();
      messageEl.textContent = "일시정지됨";
    } else if (state === "paused") {
      state = "running";
      messageEl.textContent = "";
      rafHandle = requestAnimationFrame(loop);
    }
  }

  function restartGame() {
    stopLoop();
    resetGame();
    startGame();
  }

  function fire() {
    if (fireCooldown > 0) return;
    bullets.push({ x: playerX + PLAYER_W / 2 - 2, y: H - PLAYER_H - 24 });
    fireCooldown = 12;
  }

  function nextWave() {
    wave += 1;
    resetEnemies();
    bullets = [];
  }

  function update() {
    if (moveDir !== 0) {
      playerX += moveDir * 4.5;
      playerX = Math.max(0, Math.min(W - PLAYER_W, playerX));
    }
    if (fireCooldown > 0) fireCooldown -= 1;

    bullets.forEach((b) => (b.y -= 6));
    bullets = bullets.filter((b) => b.y > -10);

    const alive = enemies.filter((e) => e.alive);
    let hitEdge = false;
    alive.forEach((e) => {
      e.x += enemyDir * (1 + wave * 0.2);
      if (e.x < 0 || e.x + ENEMY_W > W) hitEdge = true;
    });
    if (hitEdge) {
      enemyDir *= -1;
      alive.forEach((e) => (e.y += 12));
    }

    bullets.forEach((b) => {
      enemies.forEach((e) => {
        if (
          e.alive &&
          b.x < e.x + ENEMY_W &&
          b.x + 4 > e.x &&
          b.y < e.y + ENEMY_H &&
          b.y + 10 > e.y
        ) {
          e.alive = false;
          b.y = -100;
          score += 10;
          scoreEl.textContent = String(score);
        }
      });
    });

    const playerTop = H - PLAYER_H - 10;
    const enemyReachedPlayer = enemies.some((e) => e.alive && e.y + ENEMY_H >= playerTop);
    if (enemyReachedPlayer) {
      loseLife();
    }

    if (enemies.every((e) => !e.alive)) {
      nextWave();
    }
  }

  function loseLife() {
    lives -= 1;
    livesEl.textContent = String(lives);
    if (lives <= 0) {
      state = "gameover";
      stopLoop();
      messageEl.textContent = `Game Over! Score: ${score}. Restart를 눌러 다시 시작하세요.`;
    } else {
      resetEnemies();
      resetPlayer();
    }
  }

  function draw() {
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = COLORS.enemy;
    enemies.forEach((e) => {
      if (e.alive) ctx.fillRect(e.x, e.y, ENEMY_W, ENEMY_H);
    });

    ctx.fillStyle = COLORS.bullet;
    bullets.forEach((b) => ctx.fillRect(b.x, b.y, 4, 10));

    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.moveTo(playerX + PLAYER_W / 2, H - PLAYER_H - 10);
    ctx.lineTo(playerX, H - 10);
    ctx.lineTo(playerX + PLAYER_W, H - 10);
    ctx.closePath();
    ctx.fill();
  }

  const keyMap = { ArrowLeft: -1, a: -1, A: -1, ArrowRight: 1, d: 1, D: 1 };

  document.addEventListener("keydown", (e) => {
    if (!container.classList.contains("kb-active")) return;
    if (e.key in keyMap) {
      e.preventDefault();
      moveDir = keyMap[e.key];
    } else if (e.key === " ") {
      e.preventDefault();
      fire();
    }
  });

  document.addEventListener("keyup", (e) => {
    if (!container.classList.contains("kb-active")) return;
    if (e.key in keyMap && moveDir === keyMap[e.key]) {
      moveDir = 0;
    }
  });

  function bindHold(el, dir) {
    const start = () => {
      moveDir = dir;
    };
    const stop = () => {
      if (moveDir === dir) moveDir = 0;
    };
    el.addEventListener("mousedown", start);
    el.addEventListener("touchstart", (e) => {
      e.preventDefault();
      start();
    });
    el.addEventListener("mouseup", stop);
    el.addEventListener("mouseleave", stop);
    el.addEventListener("touchend", stop);
  }

  bindHold(document.getElementById("touchGalagaLeft"), -1);
  bindHold(document.getElementById("touchGalagaRight"), 1);

  const fireBtn = document.getElementById("touchGalagaFire");
  fireBtn.addEventListener("click", fire);
  fireBtn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    fire();
  });

  startBtn.addEventListener("click", startGame);
  pauseBtn.addEventListener("click", togglePause);
  restartBtn.addEventListener("click", restartGame);

  resetGame();
})();
