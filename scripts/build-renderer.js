const esbuild = require('esbuild');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const minify = !watch;

/** Non-bundled files the renderer loads by URL, copied verbatim into dist. */
const RENDERER_ASSETS = ['index.html', 'styles.css', 'copilot.png', 'fonts'];

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

/**
 * The loader that lets the *desktop* renderer run in a browser. It installs a
 * web-backed `window.whimAPI` and then pulls in the unmodified renderer
 * bundle, so there is no second copy of the UI to keep in step.
 */
const desktopBootOptions = {
  ...rendererOptions,
  entryPoints: [path.join(__dirname, '..', 'src', 'web', 'desktop', 'boot.ts')],
  outfile: path.join(__dirname, '..', 'dist', 'web', 'desktop', 'boot.js'),
};

/**
 * Assemble /desktop from the renderer's own build output.
 *
 * Two edits to the renderer's HTML: a <base> so its relative asset URLs
 * resolve under the subdirectory, and removal of the <script> tag for app.js.
 * The bundle must not evaluate until boot.js has installed the API bridge, so
 * boot.js injects it instead.
 */
function assembleDesktopBundle() {
  const rendererDist = path.join(__dirname, '..', 'dist', 'renderer');
  const target = path.join(__dirname, '..', 'dist', 'web', 'desktop');
  const source = path.join(__dirname, '..', 'src', 'renderer');
  if (!fs.existsSync(path.join(rendererDist, 'app.js'))) return;

  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(rendererDist, 'app.js'), path.join(target, 'app.js'));
  for (const asset of ['styles.css', 'copilot.png']) {
    fs.copyFileSync(path.join(source, asset), path.join(target, asset));
  }
  // styles.css references fonts relative to itself, so they land beside it.
  fs.cpSync(path.join(source, 'fonts'), path.join(target, 'fonts'), { recursive: true });

  let html = fs.readFileSync(path.join(source, 'index.html'), 'utf-8');
  html = html.replace(/<script src="app\.js"><\/script>\s*/, '');
  // Rewrite the renderer's relative asset URLs to absolute /desktop/ paths.
  // A <base> tag would be the obvious fix, but the web remote sends
  // `base-uri 'none'`, which silently neutralises it — and weakening a CSP to
  // save a string replace is a bad trade.
  html = html.replace(/(src|href)="(?!https?:|\/\/|\/|data:|#)([^"]+)"/g, '$1="/desktop/$2"');
  html = html.replace('</head>', '  <link rel="stylesheet" href="/desktop/boot.css">\n  <script src="/desktop/boot.js" defer></script>\n</head>');
  assertDesktopBundleSane(html);
  fs.writeFileSync(path.join(target, 'index.html'), html);
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'web', 'desktop', 'boot.css'), path.join(target, 'boot.css'));
}

/**
 * The renderer's HTML is authored for Electron, where it loads from a file
 * path. Guard the assumptions this rewrite depends on so a future edit to
 * index.html fails the build instead of producing a subtly broken page.
 */
function assertDesktopBundleSane(html) {
  if (/(src|href)="(?!https?:|\/\/|\/|data:|#)/.test(html)) {
    throw new Error('dist/web/desktop/index.html still contains relative asset URLs');
  }
  if (html.includes('src="/desktop/app.js"')) {
    throw new Error('app.js must be injected by boot.js, not referenced in HTML');
  }
}

/**
 * Assets the Electron renderer loads at runtime.
 *
 * `copilot-whim://app/renderer/...` resolves under `dist/`, so these have to be
 * copied even though nothing bundles them. This used to be an inline `node -e`
 * one-liner in package.json's build script with a hard-coded file list; fonts
 * are a directory, and a build step that can only copy individual files is a
 * step that quietly drops half a feature.
 */
function copyRendererAssets() {
  const srcDir = path.join(__dirname, '..', 'src', 'renderer');
  const distDir = path.join(__dirname, '..', 'dist', 'renderer');
  fs.mkdirSync(distDir, { recursive: true });
  for (const asset of RENDERER_ASSETS) {
    fs.cpSync(path.join(srcDir, asset), path.join(distDir, asset), { recursive: true });
  }
}

function copyWebAssets() {
  const srcDir = path.join(__dirname, '..', 'src', 'web');
  const distDir = path.join(__dirname, '..', 'dist', 'web');
  fs.mkdirSync(distDir, { recursive: true });
  for (const asset of ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js']) {
    fs.copyFileSync(path.join(srcDir, asset), path.join(distDir, asset));
  }
  // The lite client's stylesheet is content-hashed, so it cannot carry its
  // fonts beside itself; they are served from the web root instead.
  fs.cpSync(path.join(__dirname, '..', 'src', 'renderer', 'fonts'), path.join(distDir, 'fonts'), { recursive: true });
  copyPwaIcons(distDir);
}

/**
 * The PWA manifest needs square PNGs at web sizes. Reuse the desktop iconset
 * rather than carrying a second copy of the same artwork.
 */
function copyPwaIcons(distDir) {
  const iconset = path.join(__dirname, '..', 'build', 'icon.iconset');
  const sources = { 'icon-192.png': 'icon_128x128@2x.png', 'icon-512.png': 'icon_256x256@2x.png' };
  for (const [target, source] of Object.entries(sources)) {
    const from = path.join(iconset, source);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(distDir, target));
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
  writeServiceWorkerShell(distDir, html);
}

/**
 * The service worker precaches the shell, but the bundle filenames are only
 * known after fingerprinting — so inject the resolved list (and a build id
 * derived from it, which is what invalidates the old cache) at build time.
 *
 * The build id also folds in the *content* of the desktop remote's assets.
 * They are served under stable, unhashed URLs, so their names alone can never
 * signal that they changed; without this, a desktop-only change left the cache
 * name identical, `activate` kept the old cache, and browsers that had already
 * stored those files went on serving the previous build.
 */
function writeServiceWorkerShell(distDir, html) {
  const swPath = path.join(distDir, 'sw.js');
  if (!fs.existsSync(swPath)) return;

  const hashed = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => /^(?!https?:|\/\/)/.test(href) && /\.(js|css)$/.test(href))
    .map((href) => (href.startsWith('/') ? href : `/${href}`));

  const shell = ['/index.html', ...hashed, '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
  const buildId = crypto
    .createHash('sha256')
    .update([...shell, ...desktopAssetFingerprints(distDir)].join('|'))
    .digest('hex')
    .slice(0, 12);
  const preamble = `self.__WHIM_SHELL__ = ${JSON.stringify(shell)};\nself.__WHIM_BUILD__ = ${JSON.stringify(buildId)};\n`;

  fs.writeFileSync(swPath, preamble + fs.readFileSync(swPath, 'utf-8'));
}

/**
 * Content hashes for the desktop remote's unhashed assets, so a change to the
 * renderer rotates the service worker cache name.
 */
function desktopAssetFingerprints(distDir) {
  const desktopDir = path.join(distDir, 'desktop');
  if (!fs.existsSync(desktopDir)) return [];

  return fs
    .readdirSync(desktopDir)
    .filter((name) => /\.(js|css|html)$/.test(name))
    .sort()
    .map((name) => `desktop/${name}:${contentHash(path.join(desktopDir, name))}`);
}

/**
 * The preload runs in Electron's sandbox, where `require` resolves only a
 * short list of built-ins — not files from the app. Its API surface lives in
 * `src/shared/whim-api.ts` so the web remote can expose the same one, but tsc
 * emits that as a bare `require('../shared/whim-api')`, which the sandbox
 * cannot resolve: the preload throws, `window.whimAPI` is never defined, and
 * the entire UI comes up dead.
 *
 * So bundle it into one self-contained CJS file. This overwrites tsc's output,
 * which is why it has to run after `tsc` in the build script.
 */
const preloadOptions = {
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'preload.ts')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'main', 'preload.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify,
  // Supplied by the sandbox itself; bundling it would shadow the real one.
  external: ['electron'],
  logLevel: 'info',
  plugins: [{
    name: 'assert-preload-self-contained',
    setup(build) {
      // As a plugin rather than a call after `esbuild.build`, so watch
      // rebuilds are checked too — otherwise `npm run dev` could quietly
      // reload Electron into the same inert state the guard exists to catch.
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        assertPreloadSelfContained();
      });
    },
  }],
};

/**
 * A sandboxed preload may only require what the sandbox provides. Anything
 * else means the bundle did not actually inline its dependencies, and the app
 * would boot with no `whimAPI` at all — so fail the build instead.
 */
function assertPreloadSelfContained(outfile = preloadOptions.outfile) {
  const source = fs.readFileSync(outfile, 'utf-8');
  // `node:`-prefixed spellings resolve to the same built-ins.
  const SANDBOX_PROVIDED = new Set([
    'electron',
    'events', 'timers', 'url',
    'node:events', 'node:timers', 'node:url',
  ]);

  const problems = [];
  // Match the call site rather than a quoted specifier, so a computed
  // argument is *seen* instead of skipped. Silently ignoring the forms we
  // cannot evaluate is how a guard ends up not guarding.
  for (const match of source.matchAll(/(?:^|[^.\w$])require\(([^)]*)\)/g)) {
    const argument = match[1].trim();
    const literal = /^(["'])([^"']*)\1$/.exec(argument);
    if (!literal) {
      problems.push(`a computed specifier (\`require(${argument})\`)`);
      continue;
    }
    if (!SANDBOX_PROVIDED.has(literal[2])) problems.push(`'${literal[2]}'`);
  }

  if (problems.length > 0) {
    throw new Error(
      `dist/main/preload.js requires ${[...new Set(problems)].join(', ')}, ` +
      `which Electron's sandboxed preload loader cannot resolve. ` +
      `The preload must be fully bundled.`
    );
  }
}

async function main() {
  if (watch) {
    copyRendererAssets();
    copyWebAssets();
    const rendererCtx = await esbuild.context(rendererOptions);
    const webCtx = await esbuild.context(webOptions);
    const desktopCtx = await esbuild.context(desktopBootOptions);
    const preloadCtx = await esbuild.context(preloadOptions);
    await Promise.all([rendererCtx.watch(), webCtx.watch(), desktopCtx.watch(), preloadCtx.watch()]);
    assembleDesktopBundle();
    for (const asset of ['index.html', 'styles.css']) {
      fs.watchFile(path.join(__dirname, '..', 'src', 'renderer', asset), { interval: 300 }, assembleDesktopBundle);
    }
    for (const asset of ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js']) {
      fs.watchFile(path.join(__dirname, '..', 'src', 'web', asset), { interval: 300 }, copyWebAssets);
    }
    console.log('[esbuild] Watching renderer and web remote...');
  } else {
    await Promise.all([
      esbuild.build(rendererOptions),
      esbuild.build(webOptions),
      esbuild.build(desktopBootOptions),
      esbuild.build(preloadOptions),
    ]);
    copyRendererAssets();
    copyWebAssets();
    // Before fingerprinting: the service worker's build id folds in the hashes
    // of the desktop assets, so they have to exist first.
    assembleDesktopBundle();
    fingerprintWebAssets();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { assertPreloadSelfContained, assertDesktopBundleSane };
