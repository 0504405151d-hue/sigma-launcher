/* Серверы Java, скриншоты, бэкапы миров */
(() => {
  const el = (id) => document.getElementById(id);
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const fmtDate = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ');
  const onPage = (name, fn) => document.querySelector(`.nav[data-page=${name}]`).addEventListener('click', fn);

  /* ---------- серверы Java ---------- */
  let servers = [];
  const saveServers = () => api.setSettings({ javaServers: servers });

  function signal(ms) {
    const lvl = ms < 80 ? 4 : ms < 150 ? 3 : ms < 300 ? 2 : 1;
    return `<span class="sig">${[4, 7, 10, 12].map((h, i) => `<i style="height:${h}px" class="${i < lvl ? 'on' : ''}"></i>`).join('')}</span>`;
  }

  async function renderServers() {
    const s = await api.getSettings();
    servers = Array.isArray(s.javaServers) ? s.javaServers : [];
    el('srvFor').textContent = `Запуск через сборку «${s.profile?.name || 'Основная'}» · ${s.version || 'последний релиз'}`;
    const box = el('srvList');
    box.innerHTML = '';
    if (!servers.length) {
      box.innerHTML = '<div class="empty">Серверов пока нет. Добавь адрес сервера друга или любимого сервера ниже.</div>';
      return;
    }
    servers.forEach((srv, i) => {
      const row = document.createElement('div');
      row.className = 'jsrv';
      row.innerHTML = `
        <div class="jsrv-icon">⏳</div>
        <div class="jsrv-info">
          <div class="jsrv-top"><span class="jsrv-name"></span><span class="jsrv-addr"></span></div>
          <div class="jsrv-motd">Опрашиваю сервер...</div>
        </div>
        <div class="jsrv-meta"><b>—</b><span class="ping"></span></div>
        <button class="btn primary">Играть</button>
        <button class="btn ghost" title="Удалить">✕</button>`;
      row.querySelector('.jsrv-name').textContent = srv.name;
      row.querySelector('.jsrv-addr').textContent = srv.addr;
      const [play, del] = row.querySelectorAll('.btn');
      play.onclick = () => launchGame({ server: srv.addr.includes(':') ? srv.addr : `${srv.addr}:25565` });
      del.onclick = () => { servers.splice(i, 1); saveServers(); renderServers(); };
      box.appendChild(row);

      api.pingJava(srv.addr).then((r) => {
        const icon = row.querySelector('.jsrv-icon');
        if (!r.online) {
          icon.textContent = '💤';
          row.querySelector('.jsrv-motd').textContent = 'Сервер не отвечает';
          row.querySelector('.jsrv-meta b').textContent = 'офлайн';
          return;
        }
        if (r.favicon) {
          icon.textContent = '';
          const img = document.createElement('img');
          img.src = r.favicon;
          img.className = 'jsrv-icon';
          icon.replaceWith(img);
        } else icon.textContent = '🟩';
        row.querySelector('.jsrv-motd').textContent = r.motd || r.version;
        row.querySelector('.jsrv-meta b').textContent = `${r.players.toLocaleString('ru-RU')} / ${r.max.toLocaleString('ru-RU')}`;
        row.querySelector('.ping').innerHTML = `${r.ping} мс ${signal(r.ping)}`;
        row.title = r.version ? `Версия сервера: ${r.version}` : '';
      });
    });
  }

  el('srvAdd').onclick = () => {
    const addr = el('srvAddr').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[^\s:]+(:\d{1,5})?$/.test(addr)) return toast('Адрес вида mc.server.net или 1.2.3.4:25565');
    servers.push({ name: el('srvName').value.trim() || addr, addr });
    saveServers();
    el('srvName').value = '';
    el('srvAddr').value = '';
    renderServers();
  };
  el('srvAddr').addEventListener('keydown', (e) => e.key === 'Enter' && el('srvAdd').click());
  el('srvRefresh').onclick = renderServers;
  onPage('servers', renderServers);

  /* ---------- скриншоты ---------- */
  let shots = [];
  let cur = -1;

  async function renderShots() {
    shots = await api.shots();
    el('shotsCount').textContent = shots.length ? `${shots.length} шт. со всех сборок · F2 в игре — новый скриншот` : 'Нажми F2 в игре, чтобы сделать скриншот';
    const grid = el('shotGrid');
    grid.innerHTML = '';
    if (!shots.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Скриншотов пока нет — нажми F2 прямо в игре</div>';
      return;
    }
    shots.forEach((sh, i) => {
      const b = document.createElement('button');
      b.className = 'shot';
      b.innerHTML = '<img loading="lazy" alt="" /><span></span>';
      b.querySelector('img').src = sh.url;
      b.querySelector('span').textContent = `${fmtDate(sh.time)} · ${sh.profile}`;
      b.onclick = () => openShot(i);
      grid.appendChild(b);
    });
  }

  function openShot(i) {
    if (!shots.length) return closeShot();
    cur = (i + shots.length) % shots.length;
    const sh = shots[cur];
    el('lbImg').src = sh.url;
    el('lbInfo').textContent = `${fmtDate(sh.time)} · ${sh.profile} · ${fmtSize(sh.size)}`;
    el('lightbox').hidden = false;
  }
  function closeShot() { el('lightbox').hidden = true; cur = -1; }

  el('lbPrev').onclick = () => openShot(cur - 1);
  el('lbNext').onclick = () => openShot(cur + 1);
  el('lbClose').onclick = closeShot;
  el('lbCopy').onclick = async () => { if (await api.copyShot(shots[cur].path)) toast('Скриншот скопирован — вставь его куда угодно (Ctrl+V)', true); };
  el('lbShow').onclick = () => api.showShot(shots[cur].path);
  el('lbDel').onclick = async () => {
    await api.deleteShot(shots[cur].path);
    shots.splice(cur, 1);
    toast('Скриншот удалён в корзину', true);
    renderShots();
    if (shots.length) openShot(Math.min(cur, shots.length - 1)); else closeShot();
  };
  el('lightbox').addEventListener('mousedown', (e) => { if (e.target.id === 'lightbox') closeShot(); });
  window.addEventListener('keydown', (e) => {
    if (el('lightbox').hidden) return;
    if (e.key === 'Escape') closeShot();
    if (e.key === 'ArrowLeft') openShot(cur - 1);
    if (e.key === 'ArrowRight') openShot(cur + 1);
  });
  el('shotsRefresh').onclick = renderShots;
  onPage('shots', renderShots);

  /* ---------- фон главной ---------- */
  async function heroBackground() {
    const s = await api.getSettings();
    const hero = document.querySelector('.hero');
    let credit = hero.querySelector('.hero-credit');
    if (!credit) {
      credit = document.createElement('div');
      credit.className = 'hero-credit';
      hero.appendChild(credit);
    }
    const list = s.heroShot === false ? [] : await api.shots();
    if (!list.length) {
      hero.classList.remove('photo');
      hero.style.backgroundImage = '';
      credit.hidden = true;
      return;
    }
    const sh = list[0];
    hero.style.backgroundImage = `url("${sh.url}")`;
    hero.classList.add('photo');
    credit.textContent = `📸 ${fmtDate(sh.time)} · ${sh.profile}`;
    credit.hidden = false;
  }
  el('autoBackup').onchange = (e) => api.setSettings({ autoBackup: e.target.checked });
  api.getSettings().then((s) => { el('autoBackup').checked = s.autoBackup !== false; });
  el('heroShot').onchange = async (e) => { await api.setSettings({ heroShot: e.target.checked }); heroBackground(); };
  api.getSettings().then((s) => { el('heroShot').checked = s.heroShot !== false; });
  heroBackground();
  // после игры — вдруг появились новые скриншоты
  api.onStatus((d) => { if (d.finished) heroBackground(); });
  onPage('home', heroBackground);

  /* ---------- бэкапы миров ---------- */
  async function renderBackups() {
    const list = await api.backups();
    const box = el('backupList');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="row-sub">Бэкапов пока нет. Нажми 💾 у мира, чтобы сохранить его копию.</div>';
      return;
    }
    for (const b of list) {
      const row = document.createElement('div');
      row.className = 'backup';
      row.innerHTML = '<div class="grow"><div></div><div class="m"></div></div><button class="btn">Восстановить</button><button class="btn ghost" title="Удалить">✕</button>';
      row.querySelector('.grow div').textContent = b.world.replace(/ авто$/, ' · автобэкап');
      row.querySelector('.m').textContent = `${fmtDate(b.time)} · ${fmtSize(b.size)}`;
      const [restore, del] = row.querySelectorAll('.btn');
      restore.onclick = async () => {
        restore.disabled = true;
        try {
          const name = await api.restoreBackup(b.file);
          toast(`Восстановлено в текущую сборку как «${name}»`, true);
          document.getElementById('worldsRefresh').click();
        } catch (e) { toast(errText(e)); }
        restore.disabled = false;
      };
      del.onclick = async () => {
        if (!confirm(`Удалить бэкап «${b.world}» от ${fmtDate(b.time)}?`)) return;
        await api.deleteBackup(b.file);
        renderBackups();
      };
      box.appendChild(row);
    }
  }
  el('backupsOpen').onclick = () => api.openBackups();

  // добавляем кнопку 💾 к каждому миру, когда список миров перерисовывается
  new MutationObserver(() => {
    document.querySelectorAll('#worldList .world').forEach((row) => {
      if (row.querySelector('.bk')) return;
      const open = row.querySelector('.btn.ghost');
      const b = document.createElement('button');
      b.className = 'btn ghost bk';
      b.title = 'Сделать бэкап';
      b.textContent = '💾';
      b.onclick = async () => {
        const worldPath = row.dataset.path;
        if (!worldPath) return;
        b.disabled = true;
        b.textContent = '⏳';
        try {
          await api.backupWorld(worldPath);
          toast('Бэкап сохранён', true);
          renderBackups();
        } catch (e) { toast(errText(e)); }
        b.disabled = false;
        b.textContent = '💾';
      };
      row.insertBefore(b, open);
    });
  }).observe(el('worldList'), { childList: true });
  onPage('worlds', renderBackups);
})();
