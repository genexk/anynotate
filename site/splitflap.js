(() => {
  const host = document.querySelector("[data-flap]");
  if (!host || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const DRUM = " abcdefghijklmnopqrstuvwxyz";
  const STEP_MS = 70;
  const STAGGER_MS = 45;
  const HOLD_MS = 1500;
  const FINAL_HOLD_MS = 6000;
  const START_MS = 2500;

  const words = host.dataset.flap.split(/\s+/).filter(Boolean);
  const final = host.textContent.trim();
  words.push(final);
  const size = Math.max(...words.map((w) => w.length));
  const pad = (w) => {
    const left = Math.floor((size - w.length) / 2);
    return " ".repeat(left) + w + " ".repeat(size - w.length - left);
  };

  const label = document.createElement("span");
  label.className = "flap-label";
  label.textContent = final;
  const board = document.createElement("span");
  board.className = "flapboard";
  board.setAttribute("aria-hidden", "true");
  board.style.setProperty("--flap-step", `${STEP_MS}ms`);

  const cells = [...pad(final)].map((ch) => {
    const cell = document.createElement("span");
    cell.className = "flap";
    const parts = {};
    for (const name of ["top", "bottom", "fold", "unfold"]) {
      const half = document.createElement("span");
      half.className = `flap-${name}`;
      half.textContent = ch;
      cell.append(half);
      parts[name] = half;
    }
    board.append(cell);
    return { ch, ...parts, cell };
  });

  host.textContent = "";
  host.append(label, board);
  host.classList.add("hl-flap");

  function flip(c, next) {
    c.top.textContent = next;
    c.fold.textContent = c.ch;
    c.unfold.textContent = next;
    c.cell.classList.remove("flipping");
    void c.cell.offsetWidth;
    c.cell.classList.add("flipping");
    c.ch = next;
    setTimeout(() => { c.bottom.textContent = next; }, STEP_MS);
  }

  function spin(c, target) {
    return new Promise((done) => {
      const tick = () => {
        if (c.ch === target) return done();
        const at = DRUM.indexOf(c.ch);
        flip(c, DRUM[(at + 1) % DRUM.length]);
        setTimeout(tick, STEP_MS);
      };
      tick();
    });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function show(word) {
    const target = [...pad(word)];
    return Promise.all(cells.map((c, i) => wait(i * STAGGER_MS).then(() => spin(c, target[i]))));
  }

  const visible = () =>
    document.hidden
      ? new Promise((r) => document.addEventListener("visibilitychange", r, { once: true })).then(visible)
      : Promise.resolve();

  async function run() {
    await wait(START_MS);
    for (;;) {
      for (const word of words) {
        await visible();
        await show(word);
        await wait(word === final ? FINAL_HOLD_MS : HOLD_MS);
      }
    }
  }

  run();
})();
