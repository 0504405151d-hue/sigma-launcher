(() => {
  const el = (id) => document.getElementById(id);
  const playBtn = el('brPlay');
  let installed = false;
  let servers = [];

  async function checkInstall() {
    const st = await api.bedrockStatus();
    const tag = el('brTag');
    playBtn.disabled = false;
    playBtn.classList.add('blue');
    if (!st.supported) {
      tag.className = 'tag br warn';
      tag.textContent = 'Bedrock для ПК есть только на Windows';
      playBtn.disabled = true;
      el('brPlaySub').textContent = 'Недоступно';
      return;
    }
    installed = st.installed;
    if (installed) {
      tag.className = 'tag br ok';
      tag.textContent = `Установлена · версия ${st.version}`;
      playBtn.querySelector('.play-label').textContent = 'ИГРАТЬ';
      el('brPlaySub').textContent = 'Запустить Bedrock';
    } else {
      tag.className = 'tag br warn';
      tag.textContent = 'Bedrock не установлен';
      playBtn.querySelector('.play-label').textContent = 'КУПИТЬ';
      el('brPlaySub').textContent = 'Открыть Microsoft Store';
    }
  }

  playBtn.onclick = () => (installed ? api.bedrockLaunch() : api.bedrockStore());

  /* ---------- серверы ---------- */
  const save = () => api.setSettings({ bedrockServers: servers });

  function render() {
    const box = el('brServers');
    box.innerHTML = '';
    if (!servers.length) {
      box.innerHTML = '<div class="empty">Серверов пока нет — добавь первый ниже</div>';
      return;
    }
    servers.forEach((s, i) => {
      const card = document.createElement('div');
      card.className = 'srv';
      card.innerHTML = `
        <div class="srv-top"><span class="srv-dot"></span><span class="srv-name"></span></div>
        <div class="srv-addr"></div>
        <div class="srv-meta"><span>Онлайн: <b class="srv-pl">…</b></span><span>Пинг: <b class="srv-ping">…</b></span></div>
        <div class="srv-btns">
          <button class="btn primary blue srv-join">Играть</button>
          <button class="btn ghost srv-del" title="Удалить">✕</button>
        </div>`;
      card.querySelector('.srv-name').textContent = s.name;
      card.querySelector('.srv-addr').textContent = `${s.host}:${s.port}`;
      card.querySelector('.srv-join').onclick = () => {
        if (!installed) return toast('Сначала установи Minecraft Bedrock');
        api.bedrockConnect(s.host, s.port);
      };
      card.querySelector('.srv-del').onclick = () => {
        servers.splice(i, 1);
        save();
        render();
      };
      box.appendChild(card);
      ping(card, s);
    });
  }

  async function ping(card, s) {
    const r = await api.bedrockPing(s.host, s.port);
    const dot = card.querySelector('.srv-dot');
    if (r.online) {
      dot.className = 'srv-dot on';
      card.querySelector('.srv-pl').textContent = `${r.players.toLocaleString('ru-RU')} / ${r.max.toLocaleString('ru-RU')}`;
      card.querySelector('.srv-ping').textContent = `${r.ping} мс`;
      if (r.version) card.querySelector('.srv-addr').textContent = `${s.host}:${s.port} · ${r.version}`;
    } else {
      dot.className = 'srv-dot off';
      card.querySelector('.srv-pl').textContent = 'офлайн';
      card.querySelector('.srv-ping').textContent = '—';
    }
  }

  el('brAddBtn').onclick = () => {
    const name = el('brName').value.trim();
    const addr = el('brAddr').value.trim();
    const m = addr.match(/^([^\s:]+)(?::(\d{1,5}))?$/);
    if (!m) return toast('Адрес в формате play.server.net или play.server.net:19132');
    servers.push({ name: name || m[1], host: m[1], port: Number(m[2]) || 19132 });
    save();
    el('brName').value = '';
    el('brAddr').value = '';
    render();
  };
  el('brAddr').addEventListener('keydown', (e) => e.key === 'Enter' && el('brAddBtn').click());
  el('brRefresh').onclick = () => { render(); checkInstall(); };

  let loaded = false;
  document.querySelector('.nav[data-page=bedrock]').addEventListener('click', async () => {
    if (loaded) return;
    loaded = true;
    const s = await api.getSettings();
    servers = Array.isArray(s.bedrockServers) ? s.bedrockServers : [];
    render();
    checkInstall();
  });
})();
