(() => {
  const S = 8; // масштаб: 64px * 8 = 512
  const layout = document.querySelector('.skin-layout');
  const view = document.getElementById('edCanvas');
  const ctx = view.getContext('2d');
  const info = document.getElementById('edInfo');
  const colorInput = document.getElementById('edColor');

  /* ---------- раскладка скина 64x64 ---------- */
  // [имя, u, v, ширина, глубина, высота, слой, пара для зеркала]
  const PARTS = [
    ['Голова', 0, 0, 8, 8, 8, 1, 'Голова'],
    ['Шапка', 32, 0, 8, 8, 8, 2, 'Шапка'],
    ['Тело', 16, 16, 8, 4, 12, 1, 'Тело'],
    ['Куртка', 16, 32, 8, 4, 12, 2, 'Куртка'],
    ['Правая рука', 40, 16, 4, 4, 12, 1, 'Левая рука'],
    ['Правый рукав', 40, 32, 4, 4, 12, 2, 'Левый рукав'],
    ['Левая рука', 32, 48, 4, 4, 12, 1, 'Правая рука'],
    ['Левый рукав', 48, 48, 4, 4, 12, 2, 'Правый рукав'],
    ['Правая нога', 0, 16, 4, 4, 12, 1, 'Левая нога'],
    ['Правая штанина', 0, 32, 4, 4, 12, 2, 'Левая штанина'],
    ['Левая нога', 16, 48, 4, 4, 12, 1, 'Правая нога'],
    ['Левая штанина', 0, 48, 4, 4, 12, 2, 'Правая штанина']
  ].map(([name, u, v, w, d, h, layer, pair]) => ({ name, u, v, w, d, h, layer, pair }));
  const byName = Object.fromEntries(PARTS.map((p) => [p.name, p]));

  function faces(p) {
    const { u, v, w, d, h } = p;
    return [
      { name: 'верх', x: u + d, y: v, w, h: d },
      { name: 'низ', x: u + d + w, y: v, w, h: d },
      { name: 'правый бок', x: u, y: v + d, w: d, h },
      { name: 'перед', x: u + d, y: v + d, w, h },
      { name: 'левый бок', x: u + d + w, y: v + d, w: d, h },
      { name: 'спина', x: u + 2 * d + w, y: v + d, w, h }
    ];
  }
  const inRect = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

  // карта: для каждого пикселя — часть и грань
  const MAP = new Array(64 * 64).fill(null);
  for (const p of PARTS) {
    for (const f of faces(p)) {
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) MAP[y * 64 + x] = { part: p, face: f };
      }
    }
  }

  /* зеркальная точка: правая↔левая сторона модели */
  function mirrorPoint(x, y) {
    const m = MAP[y * 64 + x];
    if (!m) return null;
    const p = m.part;
    const t = byName[p.pair];
    let lx = x - p.u;
    const ly = y - p.v;
    const { w, d } = p;
    if (ly < d) {
      // верх/низ: зеркалим внутри своей грани
      const fx = lx < d + w ? d : d + w;
      lx = fx + (w - 1 - (lx - fx));
    } else if (lx < d) {
      lx = d + w + (d - 1 - lx); // правый бок -> левый
    } else if (lx < d + w) {
      lx = d + (w - 1 - (lx - d)); // перед
    } else if (lx < 2 * d + w) {
      lx = d - 1 - (lx - d - w); // левый бок -> правый
    } else {
      lx = 2 * d + w + (w - 1 - (lx - 2 * d - w)); // спина
    }
    return [t.u + lx, t.v + ly];
  }

  /* ---------- состояние ---------- */
  const skin = document.createElement('canvas');
  skin.width = 64; skin.height = 64;
  const sctx = skin.getContext('2d', { willReadFrequently: true });
  let img = sctx.createImageData(64, 64);

  let tool = 'pen';
  let color = '#4ade80';
  let mirror = false;
  let grid = true;
  let baseOnly = false;
  let drawing = false;
  let last = null;
  let hover = null;
  const undo = [];
  const redo = [];
  let recent = [];

  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');

  function editable(x, y) {
    const m = MAP[y * 64 + x];
    if (!m) return false;
    return !(baseOnly && m.part.layer === 2);
  }

  function setPixel(x, y, rgba) {
    if (x < 0 || y < 0 || x > 63 || y > 63 || !editable(x, y)) return;
    const i = (y * 64 + x) * 4;
    img.data[i] = rgba[0]; img.data[i + 1] = rgba[1]; img.data[i + 2] = rgba[2]; img.data[i + 3] = rgba[3];
  }

  function paint(x, y) {
    const rgba = tool === 'eraser' ? [0, 0, 0, 0] : [...hexToRgb(color), 255];
    setPixel(x, y, rgba);
    if (mirror) {
      const mp = mirrorPoint(x, y);
      if (mp) setPixel(mp[0], mp[1], rgba);
    }
  }

  function line(x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      paint(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function flood(x, y) {
    const m = MAP[y * 64 + x];
    if (!m || !editable(x, y)) return;
    const face = m.face;
    const i0 = (y * 64 + x) * 4;
    const target = img.data.slice(i0, i0 + 4).join();
    const rgba = [...hexToRgb(color), 255];
    if (target === rgba.join()) return;
    const stack = [[x, y]];
    const seen = new Set();
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const k = cy * 64 + cx;
      if (seen.has(k) || !inRect(cx, cy, face)) continue;
      seen.add(k);
      if (img.data.slice(k * 4, k * 4 + 4).join() !== target) continue;
      setPixel(cx, cy, rgba);
      if (mirror) { const mp = mirrorPoint(cx, cy); if (mp) setPixel(mp[0], mp[1], rgba); }
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  function pick(x, y) {
    const i = (y * 64 + x) * 4;
    if (img.data[i + 3] === 0) return;
    setColor(rgbToHex(img.data[i], img.data[i + 1], img.data[i + 2]));
    setTool('pen');
  }

  /* ---------- отрисовка ---------- */
  let previewQueued = false;
  function render() {
    sctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 512, 512);

    // фон: шахматка для используемых пикселей, тёмный для пустых
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const m = MAP[y * 64 + x];
        if (!m) { ctx.fillStyle = '#0b0d12'; }
        else {
          const light = ((x + y) & 1) === 0;
          ctx.fillStyle = m.part.layer === 2 ? (light ? '#2a2f3b' : '#232733') : (light ? '#3a4050' : '#333846');
        }
        ctx.fillRect(x * S, y * S, S, S);
      }
    }
    ctx.drawImage(skin, 0, 0, 512, 512);

    if (baseOnly) {
      ctx.fillStyle = 'rgba(11,13,18,.75)';
      for (const p of PARTS) if (p.layer === 2) for (const f of faces(p)) ctx.fillRect(f.x * S, f.y * S, f.w * S, f.h * S);
    }

    if (grid) {
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        ctx.moveTo(i * S + .5, 0); ctx.lineTo(i * S + .5, 512);
        ctx.moveTo(0, i * S + .5); ctx.lineTo(512, i * S + .5);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(74,222,128,.35)';
      for (const p of PARTS) for (const f of faces(p)) ctx.strokeRect(f.x * S + .5, f.y * S + .5, f.w * S - 1, f.h * S - 1);
    }

    if (hover && MAP[hover[1] * 64 + hover[0]]) {
      const pts = [hover];
      if (mirror) { const mp = mirrorPoint(hover[0], hover[1]); if (mp) pts.push(mp); }
      ctx.lineWidth = 2;
      pts.forEach(([x, y], i) => {
        ctx.strokeStyle = i ? 'rgba(255,255,255,.45)' : '#fff';
        ctx.strokeRect(x * S + 1, y * S + 1, S - 2, S - 2);
      });
    }

    if (!previewQueued) {
      previewQueued = true;
      setTimeout(() => { previewQueued = false; window.skinUI.preview(skin.toDataURL()); }, 60);
    }
  }

  /* ---------- история ---------- */
  function snapshot() {
    undo.push(new Uint8ClampedArray(img.data));
    if (undo.length > 60) undo.shift();
    redo.length = 0;
  }
  function doUndo() {
    if (!undo.length) return;
    redo.push(new Uint8ClampedArray(img.data));
    img.data.set(undo.pop());
    render();
  }
  function doRedo() {
    if (!redo.length) return;
    undo.push(new Uint8ClampedArray(img.data));
    img.data.set(redo.pop());
    render();
  }

  /* ---------- мышь ---------- */
  function cell(e) {
    const r = view.getBoundingClientRect();
    const size = Math.min(r.width, r.height);
    const ox = r.left + (r.width - size) / 2;
    const oy = r.top + (r.height - size) / 2;
    const x = Math.floor(((e.clientX - ox) / size) * 64);
    const y = Math.floor(((e.clientY - oy) / size) * 64);
    return x >= 0 && y >= 0 && x < 64 && y < 64 ? [x, y] : null;
  }

  function updateInfo(c) {
    if (!c) { info.textContent = 'Наведи на скин'; return; }
    const m = MAP[c[1] * 64 + c[0]];
    info.textContent = m ? `${m.part.name} · ${m.face.name} · ${c[0]},${c[1]}` : `Не используется · ${c[0]},${c[1]}`;
  }

  view.addEventListener('contextmenu', (e) => e.preventDefault());
  view.style.touchAction = 'none';
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture?.(e.pointerId);
    const c = cell(e);
    if (!c) return;
    if (e.button === 2 || tool === 'picker' || e.altKey) { pick(...c); render(); return; }
    snapshot();
    if (tool === 'fill') { flood(...c); addRecent(color); render(); return; }
    drawing = true;
    last = c;
    paint(...c);
    if (tool === 'pen') addRecent(color);
    render();
  });
  window.addEventListener('pointermove', (e) => {
    if (!layout.classList.contains('editing')) return;
    const c = cell(e);
    const changed = String(c) !== String(hover);
    hover = c;
    if (changed) updateInfo(c);
    if (drawing && c && last) { line(last[0], last[1], c[0], c[1]); last = c; render(); }
    else if (changed) render();
  });
  const stop = () => { drawing = false; last = null; };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);

  /* ---------- инструменты и цвет ---------- */
  function setTool(t) {
    tool = t;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    view.style.cursor = t === 'picker' ? 'copy' : t === 'fill' ? 'cell' : 'crosshair';
  }
  document.querySelectorAll('.tool[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  function setColor(c) {
    color = c.toLowerCase();
    colorInput.value = color;
    document.getElementById('edHex').textContent = color.toUpperCase();
    document.querySelectorAll('.ed-palette button').forEach((b) => b.classList.toggle('active', b.dataset.c === color));
    if (tool === 'eraser') setTool('pen');
  }
  colorInput.addEventListener('input', () => setColor(colorInput.value));

  const PALETTE = [
    '#f9d4b4', '#e0ac7e', '#c68642', '#8d5524', '#5c3a1e', '#2b1a0e',
    '#ffffff', '#c7ccd6', '#7a8194', '#3a3f4b', '#1a1d24', '#000000',
    '#ef4444', '#f97316', '#facc15', '#4ade80', '#16a34a', '#14b8a6',
    '#38bdf8', '#2563eb', '#1e3a8a', '#a855f7', '#ec4899', '#fbcfe8'
  ];
  function swatch(c) {
    const b = document.createElement('button');
    b.style.background = c;
    b.dataset.c = c;
    b.title = c.toUpperCase();
    b.onclick = () => setColor(c);
    return b;
  }
  const pal = document.getElementById('edPalette');
  PALETTE.forEach((c) => pal.appendChild(swatch(c)));

  function addRecent(c) {
    recent = [c, ...recent.filter((x) => x !== c)].slice(0, 6);
    const box = document.getElementById('edRecent');
    box.innerHTML = '';
    recent.forEach((x) => box.appendChild(swatch(x)));
    setColor(color);
  }

  const mirrorBtn = document.getElementById('edMirror');
  mirrorBtn.onclick = () => { mirror = !mirror; mirrorBtn.classList.toggle('active', mirror); render(); };
  const gridBtn = document.getElementById('edGrid');
  gridBtn.onclick = () => { grid = !grid; gridBtn.classList.toggle('active', grid); render(); };
  document.getElementById('edUndo').onclick = doUndo;
  document.getElementById('edRedo').onclick = doRedo;

  document.querySelectorAll('#edLayer button').forEach((b) => (b.onclick = () => {
    baseOnly = b.dataset.layer === 'base';
    document.querySelectorAll('#edLayer button').forEach((x) => x.classList.toggle('active', x === b));
    try {
      const s = window.skinUI.viewer.playerObject.skin;
      for (const k of ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']) s[k].outerLayer.visible = !baseOnly;
    } catch { /* превью без WebGL */ }
    render();
  }));

  document.getElementById('edClear').onclick = () => {
    snapshot();
    for (let i = 0; i < 64 * 64; i++) {
      const m = MAP[i];
      if (!m || (baseOnly && m.part.layer === 2)) continue;
      const k = i * 4;
      if (m.part.layer === 2) { img.data[k + 3] = 0; continue; }
      img.data[k] = 200; img.data[k + 1] = 200; img.data[k + 2] = 200; img.data[k + 3] = 255;
    }
    render();
  };

  document.getElementById('edExport').onclick = () => {
    if (api.exportSkin) return api.exportSkin(skin.toDataURL('image/png'));
    const a = document.createElement('a');
    a.href = skin.toDataURL('image/png');
    a.download = 'skin.png';
    a.click();
  };

  let savedRef = null;

  /* ---------- открыть / закрыть ---------- */
  function loadInto(src) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        sctx.clearRect(0, 0, 64, 64);
        sctx.drawImage(im, 0, 0);
        img = sctx.getImageData(0, 0, 64, 64);
        res();
      };
      im.src = src;
    });
  }

  async function open() {
    await loadInto(window.skinUI.current());
    undo.length = 0; redo.length = 0;
    layout.classList.add('editing');
    window.skinUI.viewer.autoRotate = false;
    setTool('pen');
    setColor(color);
    render();
    setTimeout(() => window.skinUI.resize(), 50);
  }

  function close(restore) {
    layout.classList.remove('editing');
    window.skinUI.viewer.autoRotate = true;
    if (baseOnly) document.querySelector('#edLayer [data-layer=all]').click();
    if (restore) window.skinUI.show(savedRef);
    setTimeout(() => window.skinUI.resize(), 50);
  }

  document.getElementById('skinDraw').onclick = async () => {
    savedRef = await api.getSkin();
    open();
  };
  document.getElementById('edCancel').onclick = () => close(true);
  document.getElementById('edSave').onclick = async () => {
    const url = skin.toDataURL('image/png');
    try {
      await api.setSkin(url);
      savedRef = url;
      window.skinUI.show(url);
      close(false);
      toast('Скин сохранён', true);
    } catch (e) {
      toast(String(e.message || e));
    }
  };

  /* ---------- горячие клавиши ---------- */
  window.addEventListener('keydown', (e) => {
    if (!layout.classList.contains('editing') || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'я')) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'н')) { e.preventDefault(); doRedo(); return; }
    if (e.ctrlKey || e.metaKey) return;
    const map = { b: 'pen', и: 'pen', e: 'eraser', у: 'eraser', g: 'fill', п: 'fill', i: 'picker', ш: 'picker' };
    if (map[k]) setTool(map[k]);
    else if (k === 'm' || k === 'ь') mirrorBtn.click();
    else if (k === 'h' || k === 'р') gridBtn.click();
    else if (k === 'escape') close(true);
  });
})();
