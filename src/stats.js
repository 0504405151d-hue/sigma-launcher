// Статистика игры: время, запуски, по версиям и сборкам, последние сессии
const fs = require('fs');
const path = require('path');

module.exports = function createStats(dataDir) {
  const file = path.join(dataDir, 'stats.json');
  const empty = () => ({ totalMs: 0, launches: 0, byVersion: {}, byProfile: {}, sessions: [] });

  function load() {
    try { return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return empty(); }
  }
  function save(s) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
  }

  return {
    get: load,
    launched() {
      const s = load();
      s.launches++;
      save(s);
    },
    addSession({ version, loader, profileId, profileName, start, ms }) {
      if (ms < 5000) return; // вылет сразу после запуска — не считаем
      const s = load();
      s.totalMs += ms;
      s.byVersion[version] = (s.byVersion[version] || 0) + ms;
      s.byProfile[profileId] = (s.byProfile[profileId] || 0) + ms;
      s.sessions.unshift({ version, loader, profile: profileName, start, ms });
      s.sessions = s.sessions.slice(0, 30);
      save(s);
    },
    reset() { save(empty()); }
  };
};
