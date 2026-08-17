/**
 * Give shallow bundled frameworks the versioned layout macOS requires, before
 * electron-builder signs the app.
 *
 * `@github/copilot-darwin-arm64` ships MediaRemoteAdapter.framework as a bare
 * directory holding one Mach-O and nothing else:
 *
 *   MediaRemoteAdapter.framework/MediaRemoteAdapter
 *
 * That is the *iOS* framework layout. `codesign` will happily sign it and
 * `codesign --verify --strict` calls it valid, so the failure surfaces late:
 * Apple's notary service rejects the archive with "The signature of the binary
 * is invalid." The notary reads the binary as a standalone Mach-O, but its
 * embedded code directory seals a bundle's `_CodeSignature/CodeResources`, and
 * a flat-file check of a bundle signature cannot succeed.
 *
 * macOS frameworks are versioned: the real payload lives under `Versions/A`,
 * with symlinks at the top level. Rebuild the bundle that way — plus the
 * `Info.plist` a framework is expected to carry — and both the signature and
 * the notary agree.
 *
 * This runs as an `afterPack` hook, which fires before signing, so the
 * restructured bundle is what gets signed.
 */

const fs = require('fs');
const path = require('path');

/** A framework is shallow when its top-level binary is a real file, not the symlink into Versions. */
function isShallowFramework(frameworkPath) {
  const name = path.basename(frameworkPath, '.framework');
  if (fs.existsSync(path.join(frameworkPath, 'Versions'))) return false;
  const binary = path.join(frameworkPath, name);
  return fs.existsSync(binary) && fs.lstatSync(binary).isFile();
}

function infoPlist(name, version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>${name}</string>
	<key>CFBundleIdentifier</key>
	<string>com.github.copilot.${name}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${name}</string>
	<key>CFBundlePackageType</key>
	<string>FMWK</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>CFBundleSupportedPlatforms</key>
	<array>
		<string>MacOSX</string>
	</array>
</dict>
</plist>
`;
}

function convertToVersioned(frameworkPath, version) {
  const name = path.basename(frameworkPath, '.framework');
  const versionDir = path.join(frameworkPath, 'Versions', 'A');
  const resourcesDir = path.join(versionDir, 'Resources');

  fs.mkdirSync(resourcesDir, { recursive: true });

  // Anything already at the top level is payload; move it under Versions/A.
  for (const entry of fs.readdirSync(frameworkPath)) {
    if (entry === 'Versions') continue;
    fs.renameSync(path.join(frameworkPath, entry), path.join(versionDir, entry));
  }

  fs.writeFileSync(path.join(resourcesDir, 'Info.plist'), infoPlist(name, version));

  // A stale signature from the shallow layout would seal the wrong resources.
  fs.rmSync(path.join(versionDir, '_CodeSignature'), { recursive: true, force: true });

  fs.symlinkSync('A', path.join(frameworkPath, 'Versions', 'Current'));
  fs.symlinkSync(path.join('Versions', 'Current', name), path.join(frameworkPath, name));
  fs.symlinkSync(path.join('Versions', 'Current', 'Resources'), path.join(frameworkPath, 'Resources'));
}

function findFrameworks(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith('.framework')) {
      found.push(full);
      continue; // Frameworks don't nest inside one another here.
    }
    findFrameworks(full, found);
  }
  return found;
}

exports.default = async function fixShallowFrameworks(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
  );

  const version = context.packager.appInfo.version;

  for (const framework of findFrameworks(appPath)) {
    if (!isShallowFramework(framework)) continue;
    convertToVersioned(framework, version);
    console.log(`  • repaired shallow framework  path=${path.relative(context.appOutDir, framework)}`);
  }
};
