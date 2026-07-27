const esbuild = require('esbuild');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const minify = !watch;

const rendererOptions = {
  entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'app.ts')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'renderer', 'app.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify,
  jsx: 'automatic',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
  },
  alias: {
    'react': path.resolve(__dirname, '..', 'node_modules', 'react'),
    'react-dom': path.resolve(__dirname, '..', 'node_modules', 'react-dom'),
    'react/jsx-dev-runtime': path.resolve(__dirname, 'jsx-dev-shim.js'),
    'react/jsx-runtime': path.resolve(__dirname, '..', 'node_modules', 'react', 'jsx-runtime.js'),
  },
  logLevel: 'info',
};

const webOptions = {
  ...rendererOptions,
  entryPoints: [path.join(__dirname, '..', 'src', 'web', 'index.tsx')],
  outfile: path.join(__dirname, '..', 'dist', 'web', 'app.js'),
};

function copyWebAssets() {
  const srcDir = path.join(__dirname, '..', 'src', 'web');
  const distDir = path.join(__dirname, '..', 'dist', 'web');
  fs.mkdirSync(distDir, { recursive: true });
  for (const asset of ['index.html', 'styles.css']) {
    fs.copyFileSync(path.join(srcDir, asset), path.join(distDir, asset));
  }
}

function contentHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 12);
}

/**
 * Emit content-hashed copies of the web remote's assets and point index.html
 * at them, so the bundle can be cached indefinitely instead of being
 * re-downloaded on every page load over a phone connection.
 */
function fingerprintWebAssets() {
  const distDir = path.join(__dirname, '..', 'dist', 'web');
  const htmlPath = path.join(distDir, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');

  for (const asset of ['app.js', 'styles.css']) {
    const assetPath = path.join(distDir, asset);
    if (!fs.existsSync(assetPath)) continue;

    const extension = path.extname(asset);
    const base = asset.slice(0, -extension.length);
    // Drop hashed copies from earlier builds so dist/ doesn't grow forever.
    for (const existing of fs.readdirSync(distDir)) {
      if (new RegExp(`^${base}\\.[0-9a-f]{12}\\${extension}$`).test(existing)) {
        fs.rmSync(path.join(distDir, existing));
      }
    }

    const hashed = `${base}.${contentHash(assetPath)}${extension}`;
    fs.copyFileSync(assetPath, path.join(distDir, hashed));
    html = html.split(asset).join(hashed);
  }

  fs.writeFileSync(htmlPath, html);
}

async function main() {
  if (watch) {
    copyWebAssets();
    const rendererCtx = await esbuild.context(rendererOptions);
    const webCtx = await esbuild.context(webOptions);
    await Promise.all([rendererCtx.watch(), webCtx.watch()]);
    for (const asset of ['index.html', 'styles.css']) {
      fs.watchFile(path.join(__dirname, '..', 'src', 'web', asset), { interval: 300 }, copyWebAssets);
    }
    console.log('[esbuild] Watching renderer and web remote...');
  } else {
    await Promise.all([
      esbuild.build(rendererOptions),
      esbuild.build(webOptions),
    ]);
    copyWebAssets();
    fingerprintWebAssets();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
