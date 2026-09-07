const fs = require('fs');
const path = require('path');

function verifyRendererAssets(dist) {
  for (const worker of ['main/storage-worker.js', 'main/voice-worker.js', 'shared/text-merge-node-worker.js']) {
    if (!fs.existsSync(path.join(dist, worker))) throw new Error(`Missing worker: ${worker}`);
  }
  const sizes = {};
  for (const directory of ['renderer', 'web', 'web/desktop']) {
    const root = path.join(dist, directory);
    for (const manifestName of directory === 'web/desktop'
      ? ['asset-manifest.json', 'boot-manifest.json'] : ['asset-manifest.json']) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestName), 'utf8'));
      const assets = new Set(manifest.all);
      if (!assets.has(manifest.entry) || !manifest.initial.includes(manifest.entry)) throw new Error('Entry absent from initial graph');
      for (const asset of assets) {
        if (path.isAbsolute(asset) || asset.split('/').includes('..')) throw new Error(`Asset escapes bundle: ${asset}`);
        if (!/\.(?:[A-Z0-9]{8}|[0-9a-f]{12})\.js$/.test(asset)) throw new Error(`Unhashed script: ${asset}`);
        if (!fs.existsSync(path.join(root, asset))) throw new Error(`Missing asset: ${directory}/${asset}`);
      }
      for (const [asset, imports] of Object.entries(manifest.imports)) {
        for (const dependency of imports) {
          if (!assets.has(dependency.path)) throw new Error(`Missing dependency of ${asset}: ${dependency.path}`);
          if (manifest.initial.includes(asset) && !dependency.dynamic && !manifest.initial.includes(dependency.path)) {
            throw new Error(`Initial dependency not in shell: ${dependency.path}`);
          }
        }
      }
      if (manifest.initial.some(asset => manifest.lazy.includes(asset))) throw new Error('Lazy assets precached as initial');
      sizes[`${directory}/${manifestName}`] = {
        initialBytes: manifest.initial.reduce((size, asset) => size + fs.statSync(path.join(root, asset)).size, 0),
        lazyBytes: manifest.lazy.reduce((size, asset) => size + fs.statSync(path.join(root, asset)).size, 0),
        chunks: manifest.all.length,
      };
    }
  }
  return sizes;
}

if (require.main === module) {
  console.log(JSON.stringify(verifyRendererAssets(path.resolve(process.argv[2] || 'dist'))));
}
module.exports = { verifyRendererAssets };
