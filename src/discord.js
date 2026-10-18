// Статус в Discord (Rich Presence). Работает, если Discord запущен на компьютере.
let Client = null;
try { ({ Client } = require('@xhayper/discord-rpc')); } catch { /* библиотеки нет — тихо пропускаем */ }

module.exports = function createDiscord(clientId) {
  let client = null;
  let ready = false;
  let pending = null;

  async function connect() {
    if (!Client || !clientId || client) return;
    try {
      client = new Client({ clientId, transport: { type: 'ipc' } });
      client.on('ready', () => {
        ready = true;
        if (pending) client.user?.setActivity(pending).catch(() => {});
      });
      client.on('disconnected', () => { ready = false; client = null; });
      await client.login();
    } catch {
      client = null; // Discord не запущен
    }
  }

  return {
    enabled: () => !!(Client && clientId),
    async playing({ version, loader, profile, start }) {
      pending = {
        details: `Minecraft ${version}${loader === 'fabric' ? ' · Fabric' : ''}`,
        state: profile ? `Сборка: ${profile}` : 'Ванилла',
        startTimestamp: start,
        largeImageKey: 'logo',
        largeImageText: 'Sigma Launcher',
        buttons: [{ label: 'Скачать Sigma Launcher', url: 'https://github.com/0504405151d-hue/sigma-launcher/releases/latest' }]
      };
      await connect();
      if (ready) client.user?.setActivity(pending).catch(() => {});
    },
    async stop() {
      pending = null;
      if (ready) {
        try { await client.user?.clearActivity(); } catch { /* ignore */ }
      }
    },
    async destroy() {
      try { await client?.destroy(); } catch { /* ignore */ }
      client = null;
      ready = false;
    }
  };
};
