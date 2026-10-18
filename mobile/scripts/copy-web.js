// Копирует общие файлы интерфейса из ПК-версии и собирает мост к Capacitor
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, '..', 'src', 'renderer');
const www = path.join(root, 'www');

for (const f of ['style.css', 'skin.js', 'editor.js', 'bedrock.js', 'vendor/skinview3d.bundle.js']) {
  fs.mkdirSync(path.dirname(path.join(www, f)), { recursive: true });
  fs.copyFileSync(path.join(src, f), path.join(www, f));
}

require('esbuild').buildSync({
  entryPoints: [path.join(root, 'app', 'api-mobile.js')],
  bundle: true,
  format: 'iife',
  outfile: path.join(www, 'api-mobile.js'),
  target: 'es2020'
});
console.log('web files ready');
