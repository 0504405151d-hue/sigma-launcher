const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let toastT;
function toast(msg, ok = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${ok ? ' ok' : ''}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.className = 'toast'), 3500);
}

function go(page) {
  $$('.nav[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'skin') setTimeout(() => window.skinUI && window.skinUI.resize(), 60);
}
$$('.nav[data-page]').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

/* обновления */
async function checkForUpdate(manual) {
  const u = await api.checkUpdate();
  if (u.available) {
    $('#mUpdate').hidden = false;
    $('#mUpdateVer').textContent = ` v${u.version}`;
    if (manual) toast(`Найдено обновление v${u.version}`, true);
  } else if (manual) {
    toast(u.error ? `Не удалось проверить: ${u.error}` : 'У тебя последняя версия', !u.error);
  }
}
$('#mUpdateBtn').onclick = async () => {
  await api.installUpdate();
  toast('Скачай APK и установи его поверх старого', true);
};
$('#checkUpdates').onclick = () => checkForUpdate(true);

$('#pcLink').onclick = () => api.openUrl('https://github.com/0504405151d-hue/sigma-launcher/releases/latest');

document.addEventListener('DOMContentLoaded', () => {
  $('#skinShare').onclick = async () => {
    const s = await api.getSkin();
    if (!s) return toast('Сначала загрузи или нарисуй скин');
    try { await api.exportSkin(s); } catch (e) { if (!/cancel/i.test(String(e))) toast('Не удалось сохранить скин'); }
  };
});

(async () => {
  const info = await api.appInfo();
  $('#appVer').textContent = 'v' + info.version;
  $('#aboutVer').textContent = info.version;
  checkForUpdate(false);
})();
