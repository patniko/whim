import * as path from 'path';

export interface CopilotPlatformEntrypoint {
  packageName: string;
  executableName: string;
  packageRelativePath: string;
  appRelativePath: string;
}

export function isLinuxMuslRuntime(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

export function getCopilotPlatformEntrypoints(
  platform = process.platform,
  arch = process.arch,
  linuxMusl = isLinuxMuslRuntime(),
): CopilotPlatformEntrypoint[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const variants = platform === 'linux'
    ? (linuxMusl ? ['linuxmusl', 'linux'] : ['linux', 'linuxmusl'])
    : [platform];
  // Since 1.0.113 each platform package is a single native CLI executable.
  const executableName = platform === 'win32' ? 'copilot.exe' : 'copilot';

  return variants.map((variant) => {
    const packageName = `copilot-${variant}-${arch}`;
    const packageRelativePath = pathApi.join('@github', packageName, executableName);
    return {
      packageName,
      executableName,
      packageRelativePath,
      appRelativePath: pathApi.join('node_modules', packageRelativePath),
    };
  });
}

/**
 * Where the bundled Copilot CLI executable can live, best match first. In
 * packaged builds it is unpacked from the ASAR archive (see `build.asarUnpack`),
 * because the OS cannot execute a file inside it.
 */
export function getBundledCopilotCandidates(
  appPath: string,
  platform = process.platform,
  arch = process.arch,
  linuxMusl = isLinuxMuslRuntime(),
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const root = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath;
  return getCopilotPlatformEntrypoints(platform, arch, linuxMusl)
    .map((entrypoint) => pathApi.join(root, entrypoint.appRelativePath));
}

export function getBundledSdkRuntimePaths(
  appPath: string,
  platform = process.platform,
  arch = process.arch,
  linuxMusl = isLinuxMuslRuntime(),
): { executable: string; library: string } {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const variant = platform === 'linux' && linuxMusl ? 'linuxmusl' : platform;
  const target = `${variant}-${arch}`;
  const root = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath;
  const directory = pathApi.join(root, 'node_modules', '@microsoft', `copilot-sdk-${target}`, 'prebuilds', target);
  return {
    executable: pathApi.join(directory, platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime'),
    library: pathApi.join(directory, 'runtime.node'),
  };
}
