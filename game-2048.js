(function () {
  const boardEl = document.getElementById("board2048");
  const scoreEl = document.getElementById("score2048");
  const highScoreEl = document.getElementById("highScore2048");
  const messageEl = document.getElementById("message2048");
  const restartBtn = document.getElementById("restart2048");

  if (!boardEl) return;

  const SIZE = 4;
  const HIGH_SCORE_KEY = "chansday-2048-highscore";
  let grid, score, over, won;

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

  function emptyCells() {
    const cells = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (grid[r][c] === 0) cells.push([r, c]);
      }
    }
    return cells;
  }

  function addRandomTile() {
    const cells = emptyCells();
    if (cells.length === 0) return;
    const [r, c] = cells[Math.floor(Math.random() * cells.length)];
    grid[r][c] = Math.random() < 0.9 ? 2 : 4;
  }

  function resetGame() {
    grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    score = 0;
    over = false;
    won = false;
    scoreEl.textContent = "0";
    highScoreEl.textContent = String(loadHighScore());
    messageEl.textContent = "방향키/WASD 또는 스와이프로 타일을 밀어주세요.";
    addRandomTile();
    addRandomTile();
    render();
  }

  function render() {
    boardEl.innerHTML = "";
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const value = grid[r][c];
        const tile = document.createElement("div");
        tile.className = "tile-2048";
        tile.textContent = value === 0 ? "" : String(value);
        if (value > 0) {
          const step = Math.min(Math.log2(value), 11);
          const lightness = 22 + step * 4.5;
          tile.style.background = `hsl(42, 65%, ${lightness}%)`;
          tile.style.color = step > 4 ? "#1a1300" : "#f2ede1";
        }
        boardEl.appendChild(tile);
      }
    }
  }

  function slideRowLeft(row) {
    const nonZero = row.filter((v) => v !== 0);
    const merged = [];
    let gained = 0;
    for (let i = 0; i < nonZero.length; i++) {
      if (nonZero[i] === nonZero[i + 1]) {
        const value = nonZero[i] * 2;
        merged.push(value);
        gained += value;
        if (value === 2048) won = true;
        i++;
      } else {
        merged.push(nonZero[i]);
      }
    }
    while (merged.length < SIZE) merged.push(0);
    return { row: merged, gained, moved: merged.some((v, i) => v !== row[i]) };
  }

  function rotateGridCW(g) {
    const next = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        next[c][SIZE - 1 - r] = g[r][c];
      }
    }
    return next;
  }

  function move(direction) {
    if (over) return;
    let rotations = 0;
    if (direction === "up") rotations = 3;
    else if (direction === "right") rotations = 2;
    else if (direction === "down") rotations = 1;

    let working = grid;
    for (let i = 0; i < rotations; i++) working = rotateGridCW(working);

    let moved = false;
    let gained = 0;
    const result = working.map((row) => {
      const r = slideRowLeft(row);
      if (r.moved) moved = true;
      gained += r.gained;
      return r.row;
    });

    let restored = result;
    for (let i = 0; i < (4 - rotations) % 4; i++) restored = rotateGridCW(restored);

    if (moved) {
      grid = restored;
      score += gained;
      scoreEl.textContent = String(score);
      addRandomTile();
      render();
      if (won) {
        messageEl.textContent = "2048 달성! 계속 진행할 수 있습니다.";
        won = false;
      }
      if (emptyCells().length === 0 && !canMerge()) {
        over = true;
        saveHighScoreIfNeeded();
        messageEl.textContent = `Game Over! Score: ${score}. Restart를 눌러 다시 시작하세요.`;
      }
    }
  }

  function canMerge() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = grid[r][c];
        if (c + 1 < SIZE && grid[r][c + 1] === v) return true;
        if (r + 1 < SIZE && grid[r + 1][c] === v) return true;
      }
    }
    return false;
  }

  const keyMap = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    w: "up",
    W: "up",
    s: "down",
    S: "down",
    a: "left",
    A: "left",
    d: "right",
    D: "right",
  };

  document.addEventListener("keydown", (e) => {
    if (!boardEl.parentElement.classList.contains("kb-active")) return;
    const dir = keyMap[e.key];
    if (dir) {
      e.preventDefault();
      move(dir);
    }
  });

  let touchStartX = 0;
  let touchStartY = 0;
  boardEl.addEventListener("touchstart", (e) => {
    touchStartX = e.changedTouches[0].clientX;
    touchStartY = e.changedTouches[0].clientY;
  });
  boardEl.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      move(dx > 0 ? "right" : "left");
    } else {
      move(dy > 0 ? "down" : "up");
    }
  });

  document.getElementById("touch2048Up").addEventListener("click", () => move("up"));
  document.getElementById("touch2048Down").addEventListener("click", () => move("down"));
  document.getElementById("touch2048Left").addEventListener("click", () => move("left"));
  document.getElementById("touch2048Right").addEventListener("click", () => move("right"));
  restartBtn.addEventListener("click", resetGame);

  resetGame();
})();
