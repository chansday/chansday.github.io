(function () {
  const boardEl = document.getElementById("boardMemory");
  const movesEl = document.getElementById("movesMemory");
  const matchedEl = document.getElementById("matchedMemory");
  const messageEl = document.getElementById("messageMemory");
  const restartBtn = document.getElementById("restartMemory");

  if (!boardEl) return;

  const SYMBOLS = ["★", "●", "▲", "■", "◆", "♥", "☀", "☾"];

  let cards, flipped, matchedCount, moves, locked;

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function resetGame() {
    const pairs = shuffle([...SYMBOLS, ...SYMBOLS]);
    cards = pairs.map((symbol, index) => ({ id: index, symbol, matched: false }));
    flipped = [];
    matchedCount = 0;
    moves = 0;
    locked = false;
    movesEl.textContent = "0";
    matchedEl.textContent = "0";
    messageEl.textContent = "카드를 클릭/터치해서 짝을 맞춰보세요.";
    render();
  }

  function render() {
    boardEl.innerHTML = "";
    cards.forEach((card) => {
      const el = document.createElement("div");
      el.className = "card-memory";
      const isOpen = flipped.includes(card.id) || card.matched;
      if (card.matched) el.classList.add("matched");
      else if (flipped.includes(card.id)) el.classList.add("flipped");
      el.textContent = isOpen ? card.symbol : "";
      el.addEventListener("click", () => handleFlip(card.id));
      boardEl.appendChild(el);
    });
  }

  function handleFlip(id) {
    if (locked) return;
    const card = cards.find((c) => c.id === id);
    if (!card || card.matched || flipped.includes(id)) return;

    flipped.push(id);
    render();

    if (flipped.length === 2) {
      moves += 1;
      movesEl.textContent = String(moves);
      const [a, b] = flipped;
      const cardA = cards.find((c) => c.id === a);
      const cardB = cards.find((c) => c.id === b);
      if (cardA.symbol === cardB.symbol) {
        cardA.matched = true;
        cardB.matched = true;
        matchedCount += 1;
        matchedEl.textContent = String(matchedCount);
        flipped = [];
        render();
        if (matchedCount === SYMBOLS.length) {
          messageEl.textContent = `완료! ${moves}번 만에 모두 맞췄습니다. Restart로 다시 시작하세요.`;
        }
      } else {
        locked = true;
        setTimeout(() => {
          flipped = [];
          locked = false;
          render();
        }, 700);
      }
    }
  }

  restartBtn.addEventListener("click", resetGame);

  resetGame();
})();
