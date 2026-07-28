(function () {
  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const highScoreEl = document.getElementById("highScore");
  const messageEl = document.getElementById("gameMessage");
  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const restartBtn = document.getElementById("restartBtn");

  const CELL = 20;
  const COLS = canvas.width / CELL;
  const ROWS = canvas.height / CELL;
  const TICK_MS = 150;
  const HIGH_SCORE_KEY = "chansday-snake-highscore";

  let snake, direction, nextDirection, food, enemy, score, state, tickHandle;

  function loadHighScore() {
    const stored = Number(localStorage.getItem(HIGH_SCORE_KEY));
    return Number.isFinite(stored) ? stored : 0;
  }

  function saveHighScoreIfNeeded() {
    const current = loadHighScore();
    if (score > current) {
      localStorage.setItem(HIGH_SCORE_KEY, String(score));
    }
    highScoreEl.textContent = String(Math.max(score, current));
  }

  function randomCell() {
    return {
      x: Math.floor(Math.random() * COLS),
      y: Math.floor(Math.random() * ROWS),
    };
  }

  function isOnSnake(cell) {
    return snake.some((seg) => seg.x === cell.x && seg.y === cell.y);
  }

  function spawnFood() {
    let cell;
    do {
      cell = randomCell();
    } while (isOnSnake(cell));
    return cell;
  }

  function spawnEnemy() {
    let cell;
    do {
      cell = randomCell();
    } while (isOnSnake(cell));
    return cell;
  }

  function resetState() {
    snake = [{ x: 8, y: 9 }, { x: 7, y: 9 }, { x: 6, y: 9 }];
    direction = { x: 1, y: 0 };
    nextDirection = { x: 1, y: 0 };
    food = spawnFood();
    enemy = spawnEnemy();
    score = 0;
    state = "idle";
    scoreEl.textContent = "0";
    highScoreEl.textContent = String(loadHighScore());
    messageEl.textContent = "Start를 누르거나 방향키를 눌러 시작하세요.";
  }

  function stopTick() {
    if (tickHandle !== undefined) {
      clearInterval(tickHandle);
      tickHandle = undefined;
    }
  }

  function startTick() {
    stopTick();
    tickHandle = setInterval(tick, TICK_MS);
  }

  function startGame() {
    if (state === "running") return;
    if (state === "gameover") {
      resetState();
    }
    state = "running";
    messageEl.textContent = "";
    startTick();
  }

  function togglePause() {
    if (state === "running") {
      state = "paused";
      stopTick();
      messageEl.textContent = "일시정지됨";
    } else if (state === "paused") {
      state = "running";
      messageEl.textContent = "";
      startTick();
    }
  }

  function restartGame() {
    stopTick();
    resetState();
    startGame();
  }

  function isOpposite(a, b) {
    return a.x === -b.x && a.y === -b.y;
  }

  function setDirection(dx, dy) {
    const candidate = { x: dx, y: dy };
    if (isOpposite(candidate, direction)) return;
    nextDirection = candidate;
    if (state === "idle") {
      startGame();
    }
  }

  function moveEnemy() {
    const options = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    const choice = options[Math.floor(Math.random() * options.length)];
    const next = { x: enemy.x + choice.x, y: enemy.y + choice.y };
    if (next.x >= 0 && next.x < COLS && next.y >= 0 && next.y < ROWS) {
      enemy = next;
    }
  }

  function endGame() {
    state = "gameover";
    stopTick();
    saveHighScoreIfNeeded();
    messageEl.textContent = `Game Over! Score: ${score}. Restart를 눌러 다시 시작하세요.`;
  }

  function tick() {
    direction = nextDirection;
    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };

    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
      endGame();
      return;
    }
    if (isOnSnake(head)) {
      endGame();
      return;
    }
    if (head.x === enemy.x && head.y === enemy.y) {
      endGame();
      return;
    }

    snake.unshift(head);

    if (head.x === food.x && head.y === food.y) {
      score += 1;
      scoreEl.textContent = String(score);
      food = spawnFood();
    } else {
      snake.pop();
    }

    moveEnemy();
    draw();
  }

  function draw() {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#33ff66";
    snake.forEach((seg) => {
      ctx.fillRect(seg.x * CELL, seg.y * CELL, CELL - 1, CELL - 1);
    });

    ctx.fillStyle = "#ff3355";
    ctx.fillRect(food.x * CELL, food.y * CELL, CELL - 1, CELL - 1);

    ctx.fillStyle = "#ffaa00";
    ctx.fillRect(enemy.x * CELL, enemy.y * CELL, CELL - 1, CELL - 1);
  }

  const keyMap = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    w: [0, -1],
    W: [0, -1],
    s: [0, 1],
    S: [0, 1],
    a: [-1, 0],
    A: [-1, 0],
    d: [1, 0],
    D: [1, 0],
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "p" || e.key === "P") {
      togglePause();
      return;
    }
    const mapped = keyMap[e.key];
    if (mapped) {
      e.preventDefault();
      setDirection(mapped[0], mapped[1]);
    }
  });

  startBtn.addEventListener("click", startGame);
  pauseBtn.addEventListener("click", togglePause);
  restartBtn.addEventListener("click", restartGame);

  document.getElementById("touchUp").addEventListener("click", () => setDirection(0, -1));
  document.getElementById("touchDown").addEventListener("click", () => setDirection(0, 1));
  document.getElementById("touchLeft").addEventListener("click", () => setDirection(-1, 0));
  document.getElementById("touchRight").addEventListener("click", () => setDirection(1, 0));

  resetState();
  draw();
})();
