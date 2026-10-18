const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let settings = {};
let versions = [];
let latest = {};
let filter = 'release';
let busy = false;
let update = null;

/* ---------- window buttons ---------- */
$('#btnMin').onclick = () => api.minimize();
$('#btnMax').onclick = () => api.maximize();
$('#btnClose').onclick = () => api.close();

/* ---------- navigation ---------- */
function go(page) {
  $$('.nav[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
}
$$('.nav[data-page]').forEach((b) => (b.onclick = () => go(b.dataset.page)));
$('#openGameDir').onclick = () => api.openFolder('game');
$$('[data-folder]').forEach((b) => (b.onclick = () => api.openFolder(b.dataset.folder)));

/* ---------- toast ---------- */
let toastT;
function toast(msg, ok = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${ok ? ' ok' : ''}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.className = 'toast'), 4000);
}

/* ---------- settings ---------- */
let saveT;
async function save(patch) {
  Object.assign(settings, patch);
  settings = await api.setSettings(patch);
  const n = $('#savedNote');
  n.classList.add('show');
  clearTimeout(saveT);
  saveT = setTimeout(() => n.classList.remove('show'), 1200);
}

function fillSettings() {
  $('#nickInput').value = settings.nickname;
  $('#ramMax').value = settings.ramMax;
  $('#ramVal').textContent = settings.ramMax;
  $('#fullscreen').checked = settings.fullscreen;
  $('#width').value = settings.width;
  $('#height').value = settings.height;
  $('.row.res').classList.toggle('disabled', settings.fullscreen);
  $('#closeOnLaunch').checked = settings.closeOnLaunch;
  $('#gameDir').value = settings.gameDir;
  $('#customJava').value = settings.customJava || '';
  $('#jvmArgs').value = settings.jvmArgs;
  updateRamChips();
}

function updateRamChips() {
  $$('[data-ram]').forEach((c) => c.classList.toggle('active', Number(c.dataset.ram) === Number(settings.ramMax)));
}

$('#nickInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^A-Za-z0-9_]/g, '');
  save({ nickname: e.target.value });
});
$('#ramMax').addEventListener('input', (e) => {
  $('#ramVal').textContent = e.target.value;
  settings.ramMax = Number(e.target.value);
  updateRamChips();
});
$('#ramMax').addEventListener('change', (e) => save({ ramMax: Number(e.target.value) }));
$$('[data-ram]').forEach((c) => (c.onclick = () => {
  const v = Number(c.dataset.ram);
  $('#ramMax').value = v;
  $('#ramVal').textContent = v;
  save({ ramMax: v }).then(updateRamChips);
}));
$('#fullscreen').onchange = (e) => {
  $('.row.res').classList.toggle('disabled', e.target.checked);
  save({ fullscreen: e.target.checked });
};
$('#width').onchange = (e) => save({ width: Number(e.target.value) || 1280 });
$('#height').onchange = (e) => save({ height: Number(e.target.value) || 720 });
$('#closeOnLaunch').onchange = (e) => save({ closeOnLaunch: e.target.checked });
$('#jvmArgs').onchange = (e) => save({ jvmArgs: e.target.value.trim() });

$('#pickGameDir').onclick = async () => {
  const p = await api.pickFolder();
  if (p) { await save({ gameDir: p }); $('#gameDir').value = p; loadVersions(); }
};
$('#pickJava').onclick = async () => {
  const p = await api.pickJava();
  if (p) { await save({ customJava: p }); $('#customJava').value = p; }
};
$('#clearJava').onclick = async () => { await save({ customJava: '' }); $('#customJava').value = ''; };
$('#checkUpdates').onclick = () => checkForUpdate(true);
$('#resetSettings').onclick = async () => {
  settings = await api.resetSettings();
  fillSettings();
  updateVersionLabel();
  loadVersions();
  toast('Настройки сброшены', true);
};

/* ---------- versions ---------- */
const typeGroup = (t) => (t === 'release' ? 'release' : t === 'snapshot' ? 'snapshot' : 'old');
const fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

function currentVersionId() {
  return settings.version || latest.release;
}

function updateVersionLabel() {
  const id = currentVersionId();
  $('#verPickText').textContent = id || '—';
  const v = versions.find((x) => x.id === id);
  $('#playSub').textContent = v ? (v.installed ? 'Установлена' : 'Будет скачана') : 'Готово';
}

async function loadVersions() {
  try {
    const r = await api.listVersions();
    versions = r.versions;
    latest = r.latest;
    $('#latestTag').textContent = `Последний релиз: ${latest.release}`;
    updateVersionLabel();
    renderVersions();
  } catch (e) {
    $('#latestTag').textContent = 'Нет интернета — список версий недоступен';
    $('#verList').innerHTML = '<div class="empty">Не удалось загрузить список версий. Проверь интернет.</div>';
  }
}

function renderVersions() {
  const q = $('#verSearch').value.trim().toLowerCase();
  const sel = currentVersionId();
  const list = versions.filter((v) => {
    if (q && !v.id.toLowerCase().includes(q)) return false;
    if (filter === 'installed') return v.installed;
    return typeGroup(v.type) === filter;
  });

  const box = $('#verList');
  if (!list.length) {
    box.innerHTML = `<div class="empty">${filter === 'installed' ? 'Пока ничего не установлено' : 'Ничего не найдено'}</div>`;
    return;
  }

  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const v of list.slice(0, 400)) {
    const g = typeGroup(v.type);
    const el = document.createElement('button');
    el.className = `ver${v.id === sel ? ' selected' : ''}`;
    el.innerHTML = `
      <div class="ver-icon ${g}">${g === 'release' ? 'R' : g === 'snapshot' ? 'S' : v.type === 'old_beta' ? 'β' : 'α'}</div>
      <div class="ver-info">
        <div class="ver-id"></div>
        <div class="ver-date">${fmtDate(v.releaseTime)}</div>
      </div>
      ${v.installed ? '<span class="badge">✓</span><span class="del" title="Удалить"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></span>' : ''}`;
    el.querySelector('.ver-id').textContent = v.id;
    el.onclick = async (ev) => {
      if (ev.target.closest('.del')) {
        if (busy) return;
        await api.deleteVersion(v.id);
        toast(`Версия ${v.id} удалена`, true);
        return loadVersions();
      }
      await save({ version: v.id });
      updateVersionLabel();
      renderVersions();
      go('home');
    };
    frag.appendChild(el);
  }
  box.appendChild(frag);
}

$('#verSearch').addEventListener('input', renderVersions);
$$('.filter').forEach((b) => (b.onclick = () => {
  filter = b.dataset.filter;
  $$('.filter').forEach((x) => x.classList.toggle('active', x === b));
  renderVersions();
}));
$('#verPick').onclick = () => go('versions');

/* ---------- launch ---------- */
function setStatus({ text, percent, playing, finished, code }) {
  const wrap = $('#progressWrap');
  const bar = $('#progressBar');
  const prog = bar.parentElement;
  wrap.classList.add('show');
  $('#statusText').textContent = text;

  if (playing) {
    prog.classList.remove('indet');
    bar.style.width = '100%';
    $('#statusPct').textContent = '';
    $('#playBtn').querySelector('.play-label').textContent = 'В ИГРЕ';
    return;
  }
  if (finished) {
    setBusy(false);
    bar.style.width = '0';
    $('#statusPct').textContent = '';
    setTimeout(() => !busy && wrap.classList.remove('show'), 2500);
    if (code && code !== 0) toast(`Игра закрылась с ошибкой (код ${code}). Смотри консоль.`);
    loadVersions();
    return;
  }
  if (percent > 0 && percent < 100) {
    prog.classList.remove('indet');
    bar.style.width = `${percent.toFixed(1)}%`;
    $('#statusPct').textContent = `${Math.floor(percent)}%`;
  } else {
    prog.classList.add('indet');
    $('#statusPct').textContent = '';
  }
}

function setBusy(b) {
  busy = b;
  const btn = $('#playBtn');
  btn.disabled = b;
  btn.querySelector('.play-label').textContent = b ? 'ЗАПУСК...' : 'ИГРАТЬ';
  $('#nickInput').disabled = b;
  if (!b) updateVersionLabel();
}

let lastCheck = 0;
async function checkForUpdate(manual = false) {
  lastCheck = Date.now();
  if (update || busy) return;
  const u = await api.checkUpdate();
  if (u.available) { update = u; showUpdate(); if (manual) toast(`Найдено обновление v${u.version}`, true); }
  else if (manual) toast(u.error ? `Не удалось проверить: ${u.error}` : 'У тебя последняя версия', !u.error);
}

function showUpdate() {
  const btn = $('#playBtn');
  btn.classList.add('update');
  btn.querySelector('.play-label').textContent = 'ОБНОВИТЬ';
  $('#playSub').textContent = `до версии ${update.version}`;
  const tag = $('#latestTag');
  tag.classList.add('update');
  tag.textContent = `Доступно обновление v${update.version}${update.notes ? ' — ' + update.notes : ''}`;
}

async function installUpdate() {
  setBusy(true);
  $('#playBtn').querySelector('.play-label').textContent = 'ОБНОВЛЕНИЕ...';
  try {
    const ok = await api.installUpdate();
    if (!ok) { setBusy(false); showUpdate(); toast('Скачай новую версию в открывшемся окне браузера', true); }
  } catch (e) {
    toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    setBusy(false);
    showUpdate();
    $('#progressWrap').classList.remove('show');
  }
}

$('#playBtn').onclick = async () => {
  if (busy) return;
  if (update) return installUpdate();
  setBusy(true);
  log(`> Запуск ${currentVersionId()} как ${settings.nickname}`, 'info');
  try {
    await api.launch();
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(msg);
    log(msg, 'err');
    setBusy(false);
    $('#progressWrap').classList.remove('show');
  }
};

api.onStatus(setStatus);

/* ---------- console ---------- */
const con = $('#console');
let lines = 0;
function log(text, cls) {
  const atBottom = con.scrollHeight - con.scrollTop - con.clientHeight < 40;
  const div = document.createElement('div');
  div.textContent = text;
  if (cls) div.className = cls;
  else if (/ERROR|Exception|FATAL/.test(text)) div.className = 'err';
  else if (/WARN/.test(text)) div.className = 'warn';
  con.appendChild(div);
  if (++lines > 3000) { con.firstChild.remove(); lines--; }
  if (atBottom) con.scrollTop = con.scrollHeight;
}
api.onLog((l) => String(l).split('\n').forEach((x) => x && log(x)));
$('#clearLog').onclick = () => { con.innerHTML = ''; lines = 0; };

/* ---------- init ---------- */
(async () => {
  settings = await api.getSettings();
  const info = await api.systemInfo();
  $('#totalRam').textContent = info.totalRam;
  $('#appVer').textContent = 'v' + info.version;
  const maxRam = Math.max(2048, Math.floor((info.totalRam * 0.8) / 256) * 256);
  $('#ramMax').max = maxRam;
  if (settings.ramMax > maxRam) await save({ ramMax: maxRam });
  fillSettings();
  await loadVersions();
  await checkForUpdate();
  setInterval(checkForUpdate, 10 * 60 * 1000);
  window.addEventListener('focus', () => { if (Date.now() - lastCheck > 60 * 1000) checkForUpdate(); });
})();
