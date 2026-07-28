(function () {
  const canvas = document.getElementById("breakoutCanvas");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("scoreBreakout");
  const livesEl = document.getElementById("livesBreakout");
  const messageEl = document.getElementById("messageBreakout");
  const startBtn = document.getElementById("startBreakout");
  const pauseBtn = document.getElementById("pauseBreakout");
  const restartBtn = document.getElementById("restartBreakout");
  const container = document.getElementById("game-breakout-area");

  if (!canvas) return;

  const rootStyle = getComputedStyle(document.documentElement);
  const themeColor = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
  const COLORS = {
    paddle: themeColor("--accent", "#d4af37"),
    ball: themeColor("--accent-2", "#10b981"),
    brick: themeColor("--accent", "#d4af37"),
  };

  const W = canvas.width;
  const H = canvas.height;
  const PADDLE_W = 70;
  const PADDLE_H = 10;
  const BALL_R = 6;
  const ROWS = 4;
  const COLS = 6;
  const BRICK_W = W / COLS;
  const BRICK_H = 16;
  const BRICK_TOP = 30;

  let paddleX, ball, bricks, score, lives, state, rafHandle, moveDir;

  function resetBricks() {
    bricks = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        bricks.push({ x: c * BRICK_W, y: BRICK_TOP + r * BRICK_H, alive: true });
      }
    }
  }

  function resetBall() {
    ball = { x: W / 2, y: H - 40, vx: 2.4, vy: -2.4 };
    paddleX = W / 2 - PADDLE_W / 2;
  }

  function resetGame() {
    resetBricks();
    resetBall();
    score = 0;
    lives = 3;
    state = "idle";
    moveDir = 0;
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

  function update() {
    if (moveDir !== 0) {
      paddleX += moveDir * 5;
      paddleX = Math.max(0, Math.min(W - PADDLE_W, paddleX));
    }

    ball.x += ball.vx;
    ball.y += ball.vy;

    if (ball.x < BALL_R || ball.x > W - BALL_R) ball.vx *= -1;
    if (ball.y < BALL_R) ball.vy *= -1;

    if (
      ball.y + BALL_R >= H - PADDLE_H - 4 &&
      ball.y + BALL_R <= H - 4 &&
      ball.x >= paddleX &&
      ball.x <= paddleX + PADDLE_W &&
      ball.vy > 0
    ) {
      ball.vy *= -1;
      const hitPos = (ball.x - (paddleX + PADDLE_W / 2)) / (PADDLE_W / 2);
      ball.vx = hitPos * 3.5;
    }

    if (ball.y > H) {
      lives -= 1;
      livesEl.textContent = String(lives);
      if (lives <= 0) {
        state = "gameover";
        stopLoop();
        messageEl.textContent = `Game Over! Score: ${score}. Restart를 눌러 다시 시작하세요.`;
        return;
      }
      resetBall();
      return;
    }

    bricks.forEach((brick) => {
      if (!brick.alive) return;
      if (
        ball.x + BALL_R > brick.x &&
        ball.x - BALL_R < brick.x + BRICK_W &&
        ball.y + BALL_R > brick.y &&
        ball.y - BALL_R < brick.y + BRICK_H
      ) {
        brick.alive = false;
        ball.vy *= -1;
        score += 10;
        scoreEl.textContent = String(score);
      }
    });

    if (bricks.every((b) => !b.alive)) {
      state = "win";
      stopLoop();
      messageEl.textContent = `승리! Score: ${score}. Restart를 눌러 다시 플레이하세요.`;
    }
  }

  function draw() {
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = COLORS.brick;
    bricks.forEach((brick) => {
      if (brick.alive) {
        ctx.fillRect(brick.x + 2, brick.y + 2, BRICK_W - 4, BRICK_H - 4);
      }
    });

    ctx.fillStyle = COLORS.paddle;
    ctx.fillRect(paddleX, H - PADDLE_H - 4, PADDLE_W, PADDLE_H);

    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
  }

  const keyMap = { ArrowLeft: -1, a: -1, A: -1, ArrowRight: 1, d: 1, D: 1 };

  document.addEventListener("keydown", (e) => {
    if (!container.classList.contains("kb-active")) return;
    if (e.key in keyMap) {
      e.preventDefault();
      moveDir = keyMap[e.key];
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

  bindHold(document.getElementById("touchBreakoutLeft"), -1);
  bindHold(document.getElementById("touchBreakoutRight"), 1);

  startBtn.addEventListener("click", startGame);
  pauseBtn.addEventListener("click", togglePause);
  restartBtn.addEventListener("click", restartGame);

  resetGame();
})();
