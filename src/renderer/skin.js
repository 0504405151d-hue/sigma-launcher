(() => {
  const stage = document.querySelector('.skin-stage');
  const canvas = document.getElementById('skinCanvas');
  let model = 'default';
  let currentSkin = null;

  /* placeholder skin (своя заглушка, не Стив) */
  function placeholderSkin() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const fill = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    // head
    fill('#d9a066', 0, 0, 32, 16);
    fill('#3b2a1a', 8, 0, 8, 8); fill('#3b2a1a', 0, 8, 32, 2);
    fill('#ffffff', 9, 12, 2, 1); fill('#ffffff', 13, 12, 2, 1);
    fill('#1e3a8a', 10, 12, 1, 1); fill('#1e3a8a', 14, 12, 1, 1);
    // body / arms — зелёная толстовка
    fill('#16a34a', 16, 16, 24, 16); fill('#16a34a', 40, 16, 16, 16);
    fill('#16a34a', 32, 48, 16, 16);
    fill('#15803d', 20, 20, 8, 2);
    fill('#d9a066', 44, 28, 4, 4); fill('#d9a066', 36, 60, 4, 4);
    // legs — тёмные джинсы
    fill('#1f2937', 0, 16, 16, 16); fill('#1f2937', 16, 48, 16, 16);
    fill('#111827', 4, 28, 4, 4); fill('#111827', 20, 60, 4, 4);
    return c.toDataURL();
  }

  let viewer;
  try {
    viewer = new skinview3d.SkinViewer({ canvas, width: 320, height: 460 });
  } catch (e) {
    // нет WebGL — показываем плоскую картинку
    const img = document.createElement('img');
    img.style.cssText = 'width:60%;margin:30% 20%;image-rendering:pixelated';
    canvas.replaceWith(img);
    viewer = {
      controls: {}, setSize() {},
      loadSkin(url) { img.src = url; }
    };
  }
  viewer.fov = 55;
  viewer.zoom = 0.85;
  viewer.autoRotate = true;
  viewer.autoRotateSpeed = 0.6;
  viewer.animation = new skinview3d.IdleAnimation();
  viewer.controls.enableZoom = false;

  const resize = () => viewer.setSize(stage.clientWidth, stage.clientHeight);
  new ResizeObserver(resize).observe(stage);

  function show(url) {
    currentSkin = url;
    viewer.loadSkin(url || placeholderSkin(), { model });
  }

  /* 64x32 -> 64x64 (как делает сама игра) */
  function convertLegacy(img) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0);
    const copy = (sx, sy, dx, dy, w, h) => {
      g.save();
      g.translate(dx + w, dy);
      g.scale(-1, 1);
      g.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      g.restore();
    };
    for (const [ox, oy, nx, ny] of [[0, 16, 16, 48], [40, 16, 32, 48]]) {
      copy(ox + 4, oy, nx + 4, ny, 4, 4);
      copy(ox + 8, oy, nx + 8, ny, 4, 4);
      copy(ox + 8, oy + 4, nx, ny + 4, 4, 12);
      copy(ox + 4, oy + 4, nx + 4, ny + 4, 4, 12);
      copy(ox, oy + 4, nx + 8, ny + 4, 4, 12);
      copy(ox + 12, oy + 4, nx + 12, ny + 4, 4, 12);
    }
    return c.toDataURL('image/png');
  }

  function loadFile(file) {
    if (!file || file.type !== 'image/png') return toast('Нужен PNG-файл скина');
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = async () => {
        let url;
        if (img.width === 64 && img.height === 64) url = reader.result;
        else if (img.width === 64 && img.height === 32) url = convertLegacy(img);
        else return toast(`Неверный размер ${img.width}×${img.height}. Нужен 64×64 или 64×32`);
        try {
          await api.setSkin(url);
          show(url);
          toast('Скин сохранён', true);
        } catch (e) {
          toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  const fileInput = document.getElementById('skinFile');
  document.getElementById('skinUpload').onclick = () => fileInput.click();
  fileInput.onchange = () => { loadFile(fileInput.files[0]); fileInput.value = ''; };
  document.getElementById('skinRemove').onclick = async () => {
    await api.removeSkin();
    show(null);
    toast('Скин убран', true);
  };

  const drop = document.getElementById('skinDrop');
  for (const el of [drop, stage]) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    el.addEventListener('dragleave', () => drop.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      loadFile(e.dataTransfer.files[0]);
    });
  }

  document.querySelectorAll('#skinModel button').forEach((b) => (b.onclick = () => {
    model = b.dataset.model;
    document.querySelectorAll('#skinModel button').forEach((x) => x.classList.toggle('active', x === b));
    show(currentSkin);
  }));

  const anims = {
    idle: () => new skinview3d.IdleAnimation(),
    walk: () => new skinview3d.WalkingAnimation(),
    run: () => new skinview3d.RunningAnimation()
  };
  document.querySelectorAll('#skinAnim button').forEach((b) => (b.onclick = () => {
    viewer.animation = anims[b.dataset.anim]();
    document.querySelectorAll('#skinAnim button').forEach((x) => x.classList.toggle('active', x === b));
  }));

  const toggle = document.getElementById('skinEnabled');
  toggle.onchange = () => api.setSettings({ skinEnabled: toggle.checked });

  (async () => {
    const s = await api.getSettings();
    toggle.checked = s.skinEnabled !== false;
    show(await api.getSkin());
  })();
})();
