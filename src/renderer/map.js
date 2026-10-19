/* Карта мира сверху: панорама, масштаб, метки игрока и спавна */
(() => {
  const el = (id) => document.getElementById(id);
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const view = el('mapView');
  const layer = el('mapLayer');

  let worlds = [];
  let job = 0;
  let zoom = 1;
  let panX = 0;
  let panZ = 0;
  let level = null;
  const tiles = new Map(); // "rx,rz" → canvas
  const pins = [];

  /* ---------- вид ---------- */
  function apply() {
    layer.style.transform = `translate(${panX}px, ${panZ}px) scale(${zoom})`;
    for (const p of pins) p.style.transform = `scale(${1 / zoom})`;
  }
  function centerOn(x, z) {
    panX = view.clientWidth / 2 - x * zoom;
    panZ = view.clientHeight / 2 - z * zoom;
    apply();
  }
  function zoomAt(f, cx, cz) {
    const nz = Math.min(8, Math.max(0.125, zoom * f));
    const wx = (cx - panX) / zoom;
    const wz = (cz - panZ) / zoom;
    zoom = nz;
    panX = cx - wx * zoom;
    panZ = cz - wz * zoom;
    apply();
  }

  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.map-zoom')) return;
    drag = { x: e.clientX, z: e.clientY, px: panX, pz: panZ };
    view.setPointerCapture(e.pointerId);
    view.classList.add('dragging');
  });
  view.addEventListener('pointermove', (e) => {
    const r = view.getBoundingClientRect();
    const wx = Math.floor((e.clientX - r.left - panX) / zoom);
    const wz = Math.floor((e.clientY - r.top - panZ) / zoom);
    if (tiles.size) el('mapCoords').textContent = `X: ${wx}  Z: ${wz}`;
    if (!drag) return;
    panX = drag.px + (e.clientX - drag.x);
    panZ = drag.pz + (e.clientY - drag.z);
    apply();
  });
  const endDrag = () => { drag = null; view.classList.remove('dragging'); };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  el('mapZoomIn').onclick = () => zoomAt(1.5, view.clientWidth / 2, view.clientHeight / 2);
  el('mapZoomOut').onclick = () => zoomAt(1 / 1.5, view.clientWidth / 2, view.clientHeight / 2);

  /* ---------- метки ---------- */
  function addPin(cls, icon, text, x, z) {
    const p = document.createElement('div');
    p.className = `map-pin ${cls}`;
    p.style.left = `${x}px`;
    p.style.top = `${z}px`;
    p.innerHTML = '<div><i></i><span></span></div>';
    p.querySelector('i').textContent = icon;
    p.querySelector('span').textContent = text;
    layer.appendChild(p);
    pins.push(p);
  }

  /* ---------- построение ---------- */
  function reset() {
    tiles.clear();
    pins.length = 0;
    layer.innerHTML = '';
    el('mapCoords').textContent = 'X: — Z: —';
    el('mapProgress').textContent = '';
    el('mapCenter').disabled = true;
    el('mapSave').disabled = true;
  }

  api.onMapStart((d) => {
    job = d.job;
    level = d;
    el('mapEmpty').hidden = true;
    zoom = 1;
    const c = d.player || d.spawn || { x: 0, z: 0 };
    centerOn(c.x, c.z);
    if (d.spawn) addPin('spawn', '★', 'Спавн', d.spawn.x, d.spawn.z);
    if (d.player) addPin('player', '●', settings.nickname || 'Ты', d.player.x, d.player.z);
    el('mapCenter').disabled = !(d.player || d.spawn);
    el('mapProgress').textContent = d.total ? `Рисую карту: 0 / ${d.total}` : '';
    apply();
  });

  api.onMapRegion((d) => {
    if (d.job !== job) return;
    el('mapProgress').textContent = d.done < d.total ? `Рисую карту: ${d.done} / ${d.total}` : '';
    if (!d.rgba) return;
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(d.rgba), 512, 512), 0, 0);
    c.style.left = `${d.rx * 512}px`;
    c.style.top = `${d.rz * 512}px`;
    layer.insertBefore(c, layer.querySelector('.map-pin'));
    tiles.set(`${d.rx},${d.rz}`, c);
    el('mapSave').disabled = false;
  });

  el('mapBuild').onclick = async () => {
    const w = worlds[el('mapWorld').value];
    if (!w) return toast('Сначала создай мир в игре');
    reset();
    el('mapEmpty').hidden = false;
    el('mapEmpty').querySelector('b').textContent = 'Читаю мир...';
    el('mapEmpty').querySelector('span').textContent = 'Большие миры рисуются несколько секунд — сначала область вокруг тебя.';
    el('mapBuild').disabled = true;
    try {
      const r = await api.renderMap(w.path);
      if (r.cancelled) return;
      if (!r.drawn) {
        el('mapEmpty').hidden = false;
        el('mapEmpty').querySelector('b').textContent = r.legacy ? 'Этот мир слишком старый для карты' : 'Мир пока пустой';
        el('mapEmpty').querySelector('span').textContent = r.legacy
          ? 'Карта работает для миров Minecraft 1.13 и новее.'
          : 'Зайди в мир и походи немного — потом карта появится.';
      }
    } catch (e) {
      toast(errText(e));
    } finally {
      el('mapBuild').disabled = false;
      el('mapProgress').textContent = '';
    }
  };

  el('mapCenter').onclick = () => {
    const c = level && (level.player || level.spawn);
    if (c) { zoom = Math.max(zoom, 1); centerOn(c.x, c.z); }
  };

  el('mapSave').onclick = async () => {
    if (!tiles.size) return;
    const keys = [...tiles.keys()].map((k) => k.split(',').map(Number));
    const minX = Math.min(...keys.map((k) => k[0]));
    const minZ = Math.min(...keys.map((k) => k[1]));
    const maxX = Math.max(...keys.map((k) => k[0]));
    const maxZ = Math.max(...keys.map((k) => k[1]));
    const w = (maxX - minX + 1) * 512;
    const h = (maxZ - minZ + 1) * 512;
    const scale = Math.min(1, 8192 / Math.max(w, h));
    const out = document.createElement('canvas');
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    const g = out.getContext('2d');
    g.imageSmoothingEnabled = scale < 1;
    g.fillStyle = '#0a0c10';
    g.fillRect(0, 0, out.width, out.height);
    for (const [k, c] of tiles) {
      const [rx, rz] = k.split(',').map(Number);
      g.drawImage(c, (rx - minX) * 512 * scale, (rz - minZ) * 512 * scale, 512 * scale, 512 * scale);
    }
    const ok = await api.saveMap(out.toDataURL('image/png'), `Карта ${level?.name || ''}`.trim());
    if (ok) toast('Карта сохранена', true);
  };

  /* ---------- список миров ---------- */
  async function loadWorlds(preselect) {
    worlds = await api.worlds();
    const sel = el('mapWorld');
    sel.innerHTML = '';
    if (!worlds.length) {
      sel.innerHTML = '<option>Миров пока нет</option>';
      return;
    }
    worlds.forEach((w, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `${w.name}${w.current ? '' : ' — ' + w.source}`;
      sel.appendChild(o);
    });
    const idx = preselect ? worlds.findIndex((w) => w.path === preselect) : worlds.findIndex((w) => w.current);
    sel.value = String(Math.max(0, idx));
  }

  document.querySelector('.nav[data-page=map]').addEventListener('click', () => loadWorlds());

  // кнопка 🗺 у каждого мира во вкладке «Миры»
  new MutationObserver(() => {
    document.querySelectorAll('#worldList .world').forEach((row) => {
      if (row.querySelector('.mp')) return;
      const b = document.createElement('button');
      b.className = 'btn ghost mp';
      b.title = 'Карта мира';
      b.textContent = '🗺';
      b.onclick = async () => {
        go('map');
        await loadWorlds(row.dataset.path);
        el('mapBuild').click();
      };
      row.insertBefore(b, row.querySelector('.bk') || row.querySelector('.btn.ghost'));
    });
  }).observe(el('worldList'), { childList: true });

  // при уходе со страницы останавливаем рисование
  document.querySelectorAll('.nav[data-page]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.page !== 'map' && el('mapBuild').disabled) api.cancelMap();
  }));
})();
