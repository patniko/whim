const { execFileSync } = require('child_process');
const fs = require('fs');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const platform = option('--platform', 'all');
const tag = option('--tag', process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME);
const requiredByPlatform = {
  mac: [
    'MACOS_CERTIFICATE',
    'MACOS_CERTIFICATE_PWD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ],
  win: ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
};

if (!['all', 'mac', 'win'].includes(platform)) {
  throw new Error(`Unsupported release platform: ${platform}`);
}
if (!tag || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Release tag must be a semantic version prefixed with "v"; received ${tag || '<empty>'}`);
}
if (tag !== `v${pkg.version}`) {
  throw new Error(`Release tag ${tag} does not match package.json version v${pkg.version}`);
}

const taggedCommit = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], {
  encoding: 'utf8',
}).trim();
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (taggedCommit !== headCommit) {
  throw new Error(`Release tag ${tag} does not point at the checked-out commit`);
}
if (!/^[0-9a-f]{40}$/.test(headCommit)) {
  throw new Error(`Git returned an invalid commit SHA: ${headCommit}`);
}

const platforms = platform === 'all' ? ['mac', 'win'] : [platform];
const missing = platforms.flatMap((name) =>
  requiredByPlatform[name].filter((variable) => !process.env[variable]?.trim()),
);
if (missing.length > 0) {
  throw new Error(`Missing required release inputs: ${missing.join(', ')}`);
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit_sha=${headCommit}\n`);
}
console.log(`Release preflight passed for ${tag} (${platform}) at ${headCommit}`);
