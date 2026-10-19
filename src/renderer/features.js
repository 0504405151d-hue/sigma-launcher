/* Сборки, моды (Modrinth), статистика, Discord */
(() => {
  const el = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const COLORS = ['#4ade80', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#2dd4bf'];
  const loaderName = (l) => (l === 'fabric' ? 'Fabric' : 'Ванилла');

  function fmtTime(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    return h < 100 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  }
  const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + ' млн' : n >= 1e3 ? Math.round(n / 1e3) + ' тыс' : String(n));

  async function reloadSettings() {
    settings = await api.getSettings();
    fillSettings();
    updateVersionLabel();
    if (versions.length) renderVersions();
    refreshHome();
  }

  /* ---------- главная: текущая сборка ---------- */
  function refreshHome() {
    const p = settings.profile;
    if (!p) return;
    el('profPickText').textContent = p.name;
    el('profDot').style.background = p.color || 'var(--accent)';
  }
  el('profPick').onclick = () => { go('profiles'); renderProfiles(); };

  /* ---------- сборки ---------- */
  async function renderProfiles() {
    const list = await api.profiles();
    const grid = el('profGrid');
    grid.innerHTML = '';
    for (const p of list) {
      const card = document.createElement('div');
      card.className = `prof${p.active ? ' active' : ''}`;
      card.style.setProperty('--pc', p.color || COLORS[0]);
      const mods = (p.counts.mod || 0);
      const extra = (p.counts.shader || 0) + (p.counts.resourcepack || 0);
      card.innerHTML = `
        <div class="prof-head">
          <div class="prof-icon">${esc(p.name.trim()[0] || '?').toUpperCase()}</div>
          <div style="min-width:0">
            <div class="prof-name">${esc(p.name)}</div>
            <div class="prof-sub">${esc(p.version || 'последний релиз')} · ${loaderName(p.loader)}</div>
          </div>
        </div>
        <div class="prof-meta">
          <span>Модов: <b>${mods}</b>${extra ? ` <span title="шейдеры и ресурспаки">+${extra}</span>` : ''}</span>
          <span>Наиграно: <b>${fmtTime(p.playtime)}</b></span>
        </div>
        <div class="prof-btns">
          <button class="btn grow ${p.active ? 'on' : 'primary'}" data-a="select">${p.active ? 'Активна' : 'Выбрать'}</button>
          <button class="btn" data-a="edit" title="Изменить">✎</button>
          <button class="btn" data-a="open" title="Открыть папку">📁</button>
          ${p.id === 'default' ? '' : '<button class="btn ghost" data-a="del" title="Удалить">🗑</button>'}
        </div>`;
      card.querySelector('[data-a=select]').onclick = async () => {
        if (p.active) return;
        if (busy) return toast('Дождись окончания запуска');
        await api.selectProfile(p.id);
        await reloadSettings();
        renderProfiles();
        toast(`Сборка «${p.name}» выбрана`, true);
      };
      card.querySelector('[data-a=edit]').onclick = () => openModal(p);
      card.querySelector('[data-a=open]').onclick = () => api.openProfile(p.id);
      const del = card.querySelector('[data-a=del]');
      if (del) del.onclick = async () => {
        if (!confirm(`Удалить сборку «${p.name}» вместе с её модами и мирами?`)) return;
        await api.deleteProfile(p.id);
        await reloadSettings();
        renderProfiles();
      };
      grid.appendChild(card);
    }
    const add = document.createElement('div');
    add.className = 'prof add';
    add.innerHTML = '<span>+</span>Новая сборка';
    add.onclick = () => openModal(null);
    grid.appendChild(add);
  }
  el('profNew').onclick = () => openModal(null);

  /* ---------- готовые сборки ---------- */
  document.querySelectorAll('.preset').forEach((card) => {
    const btn = card.querySelector('.btn');
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = '<div></div>';
    card.appendChild(bar);
    btn.onclick = async () => {
      if (busy) return toast('Дождись окончания запуска');
      document.querySelectorAll('.preset .btn').forEach((b) => (b.disabled = true));
      card.classList.add('busy');
      btn.textContent = 'Подбираю версию...';
      try {
        const r = await api.createPreset(card.dataset.preset);
        await reloadSettings();
        renderProfiles();
        toast(r.failed.length
          ? `Сборка готова (${r.mc}). Не нашлось для этой версии: ${r.failed.join(', ')}`
          : `Сборка готова на ${r.mc} и выбрана — жми ИГРАТЬ`, !r.failed.length);
      } catch (e) {
        toast(errText(e));
      } finally {
        card.classList.remove('busy');
        bar.firstChild.style.width = '0';
        btn.textContent = 'Создать';
        document.querySelectorAll('.preset .btn').forEach((b) => (b.disabled = false));
      }
    };
  });
  api.onPresetProgress((d) => {
    const card = document.querySelector(`.preset[data-preset="${d.key}"]`);
    if (!card) return;
    card.querySelector('.btn').textContent = d.text;
    card.querySelector('.bar div').style.width = `${(d.i / d.n) * 100}%`;
  });

  /* ---------- модалка сборки ---------- */
  let editing = null;
  let pmLoader = 'vanilla';
  let pmColor = COLORS[0];

  function fillVersionSelect(selected) {
    const showAll = el('pmSnap').checked;
    const sel = el('pmVersion');
    const list = versions.filter((v) => showAll || v.type === 'release');
    const opts = [`<option value="">Последний релиз${latest.release ? ` (${latest.release})` : ''}</option>`];
    if (selected && !list.find((v) => v.id === selected)) opts.push(`<option value="${esc(selected)}">${esc(selected)}</option>`);
    for (const v of list.slice(0, 400)) opts.push(`<option value="${esc(v.id)}">${esc(v.id)}${v.type !== 'release' ? ` · ${v.type === 'snapshot' ? 'снапшот' : 'старая'}` : ''}</option>`);
    sel.innerHTML = opts.join('');
    sel.value = selected || '';
    checkLoader();
  }

  async function checkLoader() {
    const mc = el('pmVersion').value || latest.release;
    const btn = document.querySelector('#pmLoader [data-loader=fabric]');
    const note = el('pmLoaderNote');
    note.textContent = '';
    if (!mc) return;
    const ok = await api.fabricSupported(mc);
    btn.disabled = !ok;
    btn.style.opacity = ok ? '' : '.4';
    if (!ok) {
      note.textContent = `Fabric недоступен для ${mc} — моды работают с 1.14 и новее`;
      if (pmLoader === 'fabric') setLoader('vanilla');
    }
  }

  function setLoader(l) {
    pmLoader = l;
    document.querySelectorAll('#pmLoader button').forEach((b) => b.classList.toggle('active', b.dataset.loader === l));
  }
  document.querySelectorAll('#pmLoader button').forEach((b) => (b.onclick = () => !b.disabled && setLoader(b.dataset.loader)));
  el('pmVersion').onchange = checkLoader;
  el('pmSnap').onchange = () => fillVersionSelect(el('pmVersion').value);

  const ramLabel = () => {
    const v = Number(el('pmRam').value);
    el('pmRamVal').textContent = v ? `${(v / 1024).toFixed(1).replace('.0', '')} ГБ` : 'как в настройках';
  };
  el('pmRam').oninput = ramLabel;

  function renderColors() {
    const box = el('pmColors');
    box.innerHTML = '';
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.style.background = c;
      b.className = c === pmColor ? 'active' : '';
      b.onclick = () => { pmColor = c; renderColors(); };
      box.appendChild(b);
    }
  }

  function openModal(p) {
    editing = p;
    el('pmTitle').textContent = p ? 'Изменить сборку' : 'Новая сборка';
    el('pmName').value = p ? p.name : '';
    el('pmSnap').checked = !!(p && p.version && versions.find((v) => v.id === p.version && v.type !== 'release'));
    setLoader(p ? p.loader : 'fabric');
    el('pmRam').max = el('ramMax').max;
    el('pmRam').value = p && p.ramMax ? p.ramMax : 0;
    ramLabel();
    pmColor = (p && p.color) || COLORS[Math.floor(Math.random() * COLORS.length)];
    renderColors();
    fillVersionSelect(p ? p.version : '');
    el('profModal').hidden = false;
    setTimeout(() => el('pmName').focus(), 50);
  }
  const closeModal = () => { el('profModal').hidden = true; };
  el('pmCancel').onclick = closeModal;
  el('profModal').addEventListener('mousedown', (e) => e.target.id === 'profModal' && closeModal());
  window.addEventListener('keydown', (e) => e.key === 'Escape' && !el('profModal').hidden && closeModal());

  el('pmSave').onclick = async () => {
    const data = {
      id: editing?.id,
      name: el('pmName').value,
      version: el('pmVersion').value || null,
      loader: pmLoader,
      ramMax: Number(el('pmRam').value) || null,
      color: pmColor
    };
    try {
      await api.saveProfile(data);
      closeModal();
      await reloadSettings();
      renderProfiles();
      toast(editing ? 'Сборка сохранена' : 'Сборка создана и выбрана', true);
    } catch (e) {
      toast(errText(e));
    }
  };

  /* ---------- моды ---------- */
  let mtype = 'mod';
  let offset = 0;
  let total = 0;
  let searchT = null;
  let reqId = 0;

  function modsHeader() {
    const p = settings.profile;
    el('modsFor').textContent = `Сборка «${p.name}» · ${settings.version || latest.release || '—'} · ${loaderName(p.loader)}`;
  }

  function modRow(h, installedView) {
    const row = document.createElement('div');
    row.className = 'mod';
    row.innerHTML = `
      <img class="mod-icon" alt="" />
      <div class="mod-info">
        <div class="mod-title"><span></span><small></small></div>
        <div class="mod-desc"></div>
        <div class="mod-dl"></div>
      </div>
      <button class="btn"></button>`;
    const img = row.querySelector('img');
    if (h.icon) img.src = h.icon; else img.style.visibility = 'hidden';
    row.querySelector('.mod-title span').textContent = h.title;
    row.querySelector('.mod-title small').textContent = installedView
      ? `${h.version || ''}${h.dependency ? ' · зависимость' : ''}`
      : (h.author ? `от ${h.author}` : '');
    row.querySelector('.mod-desc').textContent = installedView
      ? ({ mod: 'Мод', shader: 'Шейдер', resourcepack: 'Ресурспак' }[h.type] || '')
      : h.description;
    row.querySelector('.mod-dl').textContent = installedView ? '' : `⬇ ${fmtNum(h.downloads)} скачиваний`;
    const btn = row.querySelector('.btn');
    const setInstalled = (on) => {
      h.installed = on;
      btn.className = on ? 'btn done' : 'btn primary';
      btn.textContent = on ? '✓ Установлено' : 'Установить';
    };
    setInstalled(installedView || h.installed);
    btn.onmouseenter = () => { if (h.installed) btn.textContent = 'Удалить'; };
    btn.onmouseleave = () => { if (h.installed) btn.textContent = '✓ Установлено'; };
    btn.onclick = async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        if (h.installed) {
          await api.mrRemove(h.id);
          setInstalled(false);
          if (installedView) row.remove();
          toast(`${h.title} удалён`, true);
        } else {
          btn.textContent = 'Ставлю...';
          const r = await api.mrInstall(h.id, h.type);
          setInstalled(true);
          if (r.switched) {
            await reloadSettings();
            modsHeader();
            toast(`${h.title} установлен. Сборка переключена на Fabric`, true);
          } else {
            toast(`${h.title} установлен`, true);
          }
        }
      } catch (e) {
        setInstalled(h.installed);
        toast(errText(e));
      } finally {
        btn.disabled = false;
      }
    };
    return row;
  }

  async function loadMods(append = false) {
    const list = el('modList');
    const my = ++reqId;
    modsHeader();
    if (!append) {
      offset = 0;
      list.innerHTML = '<div class="mod-skel"></div>'.repeat(5);
    }
    el('modMore').hidden = true;

    const mc = settings.version || latest.release;
    if ((mtype === 'mod' || mtype === 'shader') && mc && !(await api.fabricSupported(mc))) {
      if (my !== reqId) return;
      list.innerHTML = `
        <div class="mods-warn">
          <div>
            <b>Для версии ${esc(mc)} ${mtype === 'mod' ? 'модов' : 'шейдеров'} нет</b>
            <span>Моды и шейдеры работают на Fabric — это Minecraft 1.14 и новее. Сделай отдельную сборку под моды, а старая версия останется в своей.</span>
          </div>
          <button class="btn primary" id="modsNewProf">Создать сборку для модов</button>
        </div>`;
      el('modsNewProf').onclick = () => { go('profiles'); renderProfiles(); openModal(null); };
      return;
    }

    if (mtype === 'installed') {
      const items = await api.mrInstalled();
      if (my !== reqId) return;
      list.innerHTML = '';
      if (!items.length) list.innerHTML = '<div class="empty">В этой сборке пока ничего не установлено</div>';
      items.sort((a, b) => (a.dependency - b.dependency) || a.title.localeCompare(b.title))
        .forEach((h) => list.appendChild(modRow(h, true)));
      return;
    }

    try {
      const r = await api.mrSearch({ query: el('modSearch').value.trim(), type: mtype, offset, sort: el('modSort').value });
      if (my !== reqId) return;
      if (!append) list.innerHTML = '';
      total = r.total;
      if (!r.hits.length && !append) list.innerHTML = `<div class="empty">Ничего не нашлось для ${esc(r.mc)}</div>`;
      r.hits.forEach((h) => list.appendChild(modRow(h, false)));
      offset += r.hits.length;
      el('modMore').hidden = offset >= total;
    } catch (e) {
      if (my !== reqId) return;
      list.innerHTML = `<div class="empty">Не удалось загрузить: ${esc(errText(e))}</div>`;
    }
  }

  document.querySelectorAll('[data-mtype]').forEach((b) => (b.onclick = () => {
    mtype = b.dataset.mtype;
    document.querySelectorAll('[data-mtype]').forEach((x) => x.classList.toggle('active', x === b));
    el('modSort').style.visibility = mtype === 'installed' ? 'hidden' : '';
    loadMods();
  }));
  el('modSearch').addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      if (mtype === 'installed') document.querySelector('[data-mtype=mod]').click();
      else loadMods();
    }, 350);
  });
  el('modSort').onchange = () => loadMods();
  el('modMore').onclick = () => loadMods(true);

  /* ---------- статистика ---------- */
  function bars(box, entries) {
    box.innerHTML = '';
    if (!entries.length) { box.innerHTML = '<div class="empty" style="padding:12px 0">Пока пусто — сыграй хотя бы раз</div>'; return; }
    const max = entries[0][1];
    for (const [name, ms] of entries.slice(0, 7)) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.title = `${name}: ${fmtTime(ms)}`;
      row.innerHTML = `<div class="bar-name"></div><div class="bar-track"><div class="bar-fill"></div></div><div class="bar-val"></div>`;
      row.querySelector('.bar-name').textContent = name;
      row.querySelector('.bar-fill').style.width = `${(ms / max) * 100}%`;
      row.querySelector('.bar-val').textContent = fmtTime(ms);
      box.appendChild(row);
    }
  }

  async function renderStats() {
    const s = await api.stats();
    el('stTotal').textContent = fmtTime(s.totalMs);
    el('stLaunches').textContent = s.launches;
    const byV = Object.entries(s.byVersion).sort((a, b) => b[1] - a[1]);
    el('stFav').textContent = byV[0]?.[0] || '—';
    bars(el('stVersions'), byV);
    bars(el('stProfiles'), Object.entries(s.byProfile)
      .map(([id, ms]) => [s.profileNames[id] || 'удалённая сборка', ms])
      .sort((a, b) => b[1] - a[1]));
    const box = el('stSessions');
    box.innerHTML = '';
    if (!s.sessions.length) box.innerHTML = '<div class="empty" style="padding:12px 0">Сессий пока нет</div>';
    for (const x of s.sessions.slice(0, 12)) {
      const d = new Date(x.start);
      const row = document.createElement('div');
      row.className = 'sess';
      row.innerHTML = `<span></span><span class="m"></span><span class="m"></span><span class="r"></span>`;
      const c = row.children;
      c[0].textContent = `${x.version}${x.loader === 'fabric' ? ' · Fabric' : ''}`;
      c[1].textContent = x.profile || '';
      c[2].textContent = d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      c[3].textContent = fmtTime(x.ms);
      box.appendChild(row);
    }
  }
  el('statsReset').onclick = async () => {
    if (!confirm('Сбросить всю статистику?')) return;
    await api.resetStats();
    renderStats();
  };

  /* ---------- Discord ---------- */
  el('discordRpc').onchange = (e) => save({ discordRpc: e.target.checked });

  /* ---------- навигация ---------- */
  document.querySelectorAll('.nav[data-page]').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.page;
    if (p === 'profiles') renderProfiles();
    if (p === 'mods') loadMods();
    if (p === 'stats') renderStats();
  }));

  // после закрытия игры обновляем статистику и сборки
  api.onStatus((d) => {
    if (!d.finished) return;
    if (document.getElementById('page-stats').classList.contains('active')) renderStats();
    if (document.getElementById('page-profiles').classList.contains('active')) renderProfiles();
  });

  (async () => {
    const s = await api.getSettings();
    el('discordRpc').checked = s.discordRpc !== false;
    if (!(await api.discordAvailable())) {
      el('discordRpc').closest('.row').remove();
    }
    settings = { ...settings, ...s };
    refreshHome();
    updateVersionLabel();
  })();
})();
