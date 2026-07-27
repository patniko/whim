const fs = require('fs');
const path = require('path');

// Fonts are not watched: they are static files that only change when someone
// deliberately replaces them, and the initial copy already picks that up.
const watched = ['index.html', 'styles.css', 'copilot.png'];
const srcDir = path.join(__dirname, '..', 'src', 'renderer');
const distDir = path.join(__dirname, '..', 'dist', 'renderer');

function copy() {
  for (const f of watched) {
    fs.copyFileSync(path.join(srcDir, f), path.join(distDir, f));
  }
}

copy();

for (const f of watched) {
  fs.watchFile(path.join(srcDir, f), { interval: 300 }, () => {
    console.log(`[watch] ${f} changed, copying...`);
    copy();
  });
}

console.log('[watch] Watching renderer assets for changes...');
