(function () {
  const boardEl = document.getElementById("boardMole");
  const scoreEl = document.getElementById("scoreMole");
  const timeEl = document.getElementById("timeMole");
  const messageEl = document.getElementById("messageMole");
  const startBtn = document.getElementById("startMole");
  const restartBtn = document.getElementById("restartMole");

  if (!boardEl) return;

  const HOLE_COUNT = 9;
  const GAME_SECONDS = 30;
  const HIGH_SCORE_KEY = "chansday-mole-highscore";

  let holes, score, timeLeft, state, moleHandle, timerHandle, activeHole;

  function loadHighScore() {
    const stored = Number(localStorage.getItem(HIGH_SCORE_KEY));
    return Number.isFinite(stored) ? stored : 0;
  }

  function saveHighScoreIfNeeded() {
    const current = loadHighScore();
    if (score > current) localStorage.setItem(HIGH_SCORE_KEY, String(score));
  }

  function render() {
    boardEl.innerHTML = "";
    for (let i = 0; i < HOLE_COUNT; i++) {
      const el = document.createElement("div");
      el.className = "hole-mole" + (i === activeHole ? " up" : "");
      el.addEventListener("click", () => whack(i));
      boardEl.appendChild(el);
    }
  }

  function whack(index) {
    if (state !== "running") return;
    if (index === activeHole) {
      score += 1;
      scoreEl.textContent = String(score);
      activeHole = -1;
      render();
    }
  }

  function popMole() {
    activeHole = Math.floor(Math.random() * HOLE_COUNT);
    render();
  }

  function stopTimers() {
    if (moleHandle !== undefined) {
      clearInterval(moleHandle);
      moleHandle = undefined;
    }
    if (timerHandle !== undefined) {
      clearInterval(timerHandle);
      timerHandle = undefined;
    }
  }

  function resetGame() {
    stopTimers();
    score = 0;
    timeLeft = GAME_SECONDS;
    state = "idle";
    activeHole = -1;
    scoreEl.textContent = "0";
    timeEl.textContent = String(GAME_SECONDS);
    messageEl.textContent = "Start를 눌러 시작하세요.";
    render();
  }

  function startGame() {
    if (state === "running") return;
    stopTimers();
    score = 0;
    timeLeft = GAME_SECONDS;
    state = "running";
    scoreEl.textContent = "0";
    timeEl.textContent = String(timeLeft);
    messageEl.textContent = "";
    popMole();
    moleHandle = setInterval(popMole, 800);
    timerHandle = setInterval(() => {
      timeLeft -= 1;
      timeEl.textContent = String(timeLeft);
      if (timeLeft <= 0) {
        endGame();
      }
    }, 1000);
  }

  function endGame() {
    state = "over";
    stopTimers();
    activeHole = -1;
    render();
    saveHighScoreIfNeeded();
    messageEl.textContent = `종료! Score: ${score} (최고: ${Math.max(score, loadHighScore())}). Restart로 다시 시작하세요.`;
  }

  startBtn.addEventListener("click", startGame);
  restartBtn.addEventListener("click", resetGame);

  resetGame();
})();
