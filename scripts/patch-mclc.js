// Fix MCLC bug: duplicate natives jars are unlinked twice in parallel -> ENOENT crash
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'node_modules', 'minecraft-launcher-core', 'components', 'handler.js');
let src = fs.readFileSync(f, 'utf8');
if (src.includes('/*sigma-patched*/')) process.exit(0);
src = src.replace(
  'fs.unlinkSync(path.join(nativeDirectory, name))',
  '/*sigma-patched*/ fs.rmSync(path.join(nativeDirectory, name), { force: true })'
);
src = src.replace(
  'const stat = await natives()',
  'const stat = [...new Map((await natives()).filter(Boolean).map(n => [n.url, n])).values()]'
);
fs.writeFileSync(f, src);
console.log('MCLC patched');
