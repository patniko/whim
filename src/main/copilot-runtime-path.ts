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

export function getBundledCopilotCandidates(
  appPath: string,
  platform = process.platform,
  arch = process.arch,
  linuxMusl = isLinuxMuslRuntime(),
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const nativeRelativePaths = getCopilotPlatformEntrypoints(platform, arch, linuxMusl)
    .map((entrypoint) => entrypoint.appRelativePath);
  const legacyRelativePath = pathApi.join('node_modules', '@github', 'copilot', 'index.js');

  if (appPath.endsWith('.asar')) {
    return [
      ...nativeRelativePaths.map((relativePath) => pathApi.join(`${appPath}.unpacked`, relativePath)),
      pathApi.join(`${appPath}.unpacked`, legacyRelativePath),
      pathApi.join(appPath, legacyRelativePath),
    ];
  }

  return [
    ...nativeRelativePaths.map((relativePath) => pathApi.join(appPath, relativePath)),
    pathApi.join(appPath, legacyRelativePath),
  ];
}
