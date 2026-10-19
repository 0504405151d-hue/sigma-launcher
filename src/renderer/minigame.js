/* Мини-игра на время загрузки: прыгай через криперов и кактусы */
(() => {
  const el = (id) => document.getElementById(id);
  const cv = el('gameCanvas');
  const g = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  const GROUND = H - 34;
  const PX = 4; // размер «пикселя»

  let best = 0;
  try { best = Number(localStorage.getItem('sigmaGameBest')) || 0; } catch { /* хранилище недоступно */ }

  let running = false;
  let raf = 0;
  let state;

  function reset() {
    state = { y: 0, vy: 0, speed: 6, obs: [], spawnIn: 60, score: 0, dead: false, t: 0, clouds: [[120, 30], [460, 50], [760, 24]] };
  }

  // фигурки из «пикселей»
  const STEVE = [
    '..hhhh..', '..hhhh..', '..ssss..', '..sees..', '..ssss..',
    '.tttttt.', 'stttttts', 'stttttts', 's.tttt.s', '..bbbb..', '..bb.bb.', '..bb.bb.'
  ];
  const CREEPER = ['gggg', 'gkkg', 'gggg', 'gkkg', 'gkkg', 'gggg', 'gggg', 'g..g', 'gggg'];
  const CACTUS = ['.cc.', '.cc.', 'ccc.', '.cc.', '.ccc', '.cc.', '.cc.', '.cc.'];
  const COLORS = { h: '#3b2a1a', s: '#d9a066', e: '#2b3a8f', t: '#2aa5a0', b: '#36379c', g: '#5fae3a', k: '#1f2a12', c: '#4b8a2a' };

  function sprite(rows, x, y) {
    rows.forEach((row, ry) => [...row].forEach((ch, rx) => {
      if (ch === '.') return;
      g.fillStyle = COLORS[ch];
      g.fillRect(x + rx * PX, y + ry * PX, PX, PX);
    }));
  }

  function jump() {
    if (!running) return;
    if (state.dead) { reset(); return; }
    if (state.y === 0) state.vy = 13;
  }

  function step() {
    const s = state;
    if (!s.dead) {
      s.t++;
      s.speed = 6 + s.t / 600;
      s.score = Math.floor(s.t / 6);
      s.vy -= 0.75;
      s.y = Math.max(0, s.y + s.vy);
      if (s.y === 0) s.vy = 0;
      if (--s.spawnIn <= 0) {
        const creeper = Math.random() < 0.5;
        s.obs.push({ x: W + 10, rows: creeper ? CREEPER : CACTUS });
        s.spawnIn = 45 + Math.random() * 60 - Math.min(25, s.t / 120);
      }
      s.obs.forEach((o) => { o.x -= s.speed; });
      s.obs = s.obs.filter((o) => o.x > -40);
      s.clouds.forEach((c) => { c[0] -= s.speed / 6; if (c[0] < -80) c[0] = W + 20; });
      // столкновение
      const px = 80;
      const py = GROUND - STEVE.length * PX - s.y;
      for (const o of s.obs) {
        const ow = o.rows[0].length * PX;
        const oh = o.rows.length * PX;
        if (px + 6 < o.x + ow && px + 8 * PX - 6 > o.x && py + STEVE.length * PX > GROUND - oh + 4) {
          s.dead = true;
          if (s.score > best) {
            best = s.score;
            try { localStorage.setItem('sigmaGameBest', String(best)); } catch { /* ignore */ }
          }
        }
      }
    }

    // небо, облака, земля
    g.fillStyle = '#8ec5ff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    s.clouds.forEach(([x, y]) => { g.fillRect(x, y, 64, 12); g.fillRect(x + 12, y - 8, 36, 8); });
    g.fillStyle = '#5fae3a';
    g.fillRect(0, GROUND, W, 8);
    g.fillStyle = '#7a5233';
    g.fillRect(0, GROUND + 8, W, H - GROUND - 8);
    g.fillStyle = '#694529';
    for (let x = -(s.t * s.speed) % 32; x < W; x += 32) g.fillRect(x, GROUND + 16, 12, 6);

    s.obs.forEach((o) => sprite(o.rows, o.x, GROUND - o.rows.length * PX));
    sprite(STEVE, 80, GROUND - STEVE.length * PX - s.y);

    if (s.dead) {
      g.fillStyle = 'rgba(11,13,18,.6)';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#fff';
      g.font = 'bold 22px "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.fillText(`Бабах! Счёт: ${s.score}`, W / 2, H / 2 - 6);
      g.font = '14px "Segoe UI", sans-serif';
      g.fillText('Пробел или клик — ещё раз', W / 2, H / 2 + 18);
    }
    el('gameScore').textContent = s.score;
    el('gameBest').textContent = best ? `рекорд: ${best}` : '';
    raf = requestAnimationFrame(step);
  }

  function open() {
    el('minigame').hidden = false;
    el('gameOpen').hidden = true;
    if (running) return;
    running = true;
    reset();
    raf = requestAnimationFrame(step);
  }
  function close() {
    running = false;
    cancelAnimationFrame(raf);
    el('minigame').hidden = true;
  }

  el('gameOpen').onclick = open;
  el('gameClose').onclick = close;
  cv.addEventListener('pointerdown', jump);
  window.addEventListener('keydown', (e) => {
    if (!running || e.target.tagName === 'INPUT') return;
    if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); jump(); }
  });

  // кнопка появляется только во время загрузки, а при старте игры всё закрывается
  api.onStatus((d) => {
    if (d.playing || d.finished) {
      close();
      el('gameOpen').hidden = true;
    } else if (!running && document.getElementById('progressWrap').classList.contains('show')) {
      el('gameOpen').hidden = false;
    }
  });
  new MutationObserver(() => {
    if (!document.getElementById('progressWrap').classList.contains('show') && !running) el('gameOpen').hidden = true;
  }).observe(document.getElementById('progressWrap'), { attributes: true, attributeFilter: ['class'] });
})();
