(() => {
  const el = (id) => document.getElementById(id);
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const fmt = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function render() {
    const s = await api.getSettings();
    el('worldsFor').textContent = `Текущая сборка: «${s.profile?.name || 'Основная'}»`;
    const list = await api.worlds();
    const box = el('worldList');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="empty">Миров пока нет — создай мир в игре</div>';
      return;
    }
    const groups = new Map();
    for (const w of list) {
      if (!groups.has(w.sourceKey)) groups.set(w.sourceKey, { label: w.source, current: w.current, items: [] });
      groups.get(w.sourceKey).items.push(w);
    }
    const ordered = [...groups.values()].sort((a, b) => b.current - a.current);
    for (const g of ordered) {
      const h = document.createElement('div');
      h.className = 'world-group';
      h.textContent = g.label;
      if (g.current) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'текущая';
        h.appendChild(b);
      }
      box.appendChild(h);
      for (const w of g.items) {
        const row = document.createElement('div');
        row.className = 'world';
        const icon = w.icon ? Object.assign(document.createElement('img'), { src: w.icon, className: 'world-icon' })
          : Object.assign(document.createElement('div'), { className: 'world-icon ph', textContent: '🌍' });
        row.appendChild(icon);
        const info = document.createElement('div');
        info.className = 'world-info';
        info.innerHTML = '<div class="world-name"></div><div class="world-sub"></div>';
        info.firstChild.textContent = w.name;
        info.lastChild.textContent = `Последняя игра: ${fmt(w.played)}`;
        row.appendChild(info);
        if (!w.current) {
          const btn = document.createElement('button');
          btn.className = 'btn primary';
          btn.textContent = 'Перенести сюда';
          btn.onclick = async () => {
            btn.disabled = true;
            btn.textContent = 'Копирую...';
            try {
              const name = await api.copyWorld(w.path);
              toast(`Мир «${name}» скопирован в текущую сборку`, true);
              render();
            } catch (e) {
              toast(errText(e));
              btn.disabled = false;
              btn.textContent = 'Перенести сюда';
            }
          };
          row.appendChild(btn);
        }
        const open = document.createElement('button');
        open.className = 'btn ghost';
        open.title = 'Открыть папку';
        open.textContent = '📁';
        open.onclick = () => api.openWorld(w.path);
        row.appendChild(open);
        box.appendChild(row);
      }
    }
  }

  el('worldsRefresh').onclick = render;
  document.querySelector('.nav[data-page=worlds]').addEventListener('click', render);
})();
