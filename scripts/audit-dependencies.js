const { spawnSync } = require('child_process');

/**
 * Vulnerabilities we knowingly ship with, because no fix exists.
 *
 * Both sit under `@huggingface/transformers`, which is used for local
 * embeddings. Neither is reachable the way whim uses it: `adm-zip` unpacks the
 * onnxruntime binary we ship, and `sharp` decodes images, which whim never
 * asks the embedding pipeline to do. They are listed by exact advisory so an
 * upgrade that introduces a *different* problem in the same package still
 * fails the audit.
 */
const ADVISORY_ID = 'GHSA-xcpc-8h2w-3j85';
const SHARP_ADVISORY_ID = 'GHSA-f88m-g3jw-g9cj';
const EXPECTED_CHAIN = {
  '@huggingface/transformers': {
    severity: 'high',
    isDirect: true,
    via: ['onnxruntime-node', 'sharp'],
    effects: [],
  },
  'onnxruntime-node': {
    severity: 'high',
    isDirect: true,
    via: ['adm-zip'],
    effects: ['@huggingface/transformers'],
  },
  'adm-zip': {
    severity: 'high',
    isDirect: false,
    advisory: ADVISORY_ID,
    effects: ['onnxruntime-node'],
  },
  sharp: {
    severity: 'high',
    isDirect: false,
    advisory: SHARP_ADVISORY_ID,
    effects: ['@huggingface/transformers'],
  },
};

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function validateReport(report) {
  if (!report || typeof report !== 'object' || report.error) {
    throw new Error(`npm audit operational error: ${report?.error?.summary || report?.error?.message || 'invalid report'}`);
  }
  if (report.auditReportVersion !== 2 || !report.vulnerabilities || !report.metadata?.vulnerabilities) {
    throw new Error('npm audit returned an unsupported or incomplete JSON report');
  }

  const names = Object.keys(report.vulnerabilities);
  if (names.length === 0) return [];

  const expectedNames = Object.keys(EXPECTED_CHAIN);
  if (!sameStrings(names, expectedNames)) {
    throw new Error(`Unaccepted vulnerability records: ${names.filter((name) => !expectedNames.includes(name)).join(', ') || 'incomplete accepted chain'}`);
  }

  for (const [name, expected] of Object.entries(EXPECTED_CHAIN)) {
    const details = report.vulnerabilities[name];
    if (details.severity !== expected.severity || details.isDirect !== expected.isDirect) {
      throw new Error(`Unexpected severity/directness for ${name}`);
    }
    if (!sameStrings(details.effects, expected.effects)) {
      throw new Error(`Unexpected dependency effects for ${name}`);
    }

    if (expected.advisory) {
      if (!Array.isArray(details.via) || details.via.length !== 1 || typeof details.via[0] !== 'object') {
        throw new Error(`${name} must contain exactly one advisory`);
      }
      const advisory = details.via[0];
      if (
        advisory.name !== name
        || advisory.dependency !== name
        || advisory.severity !== expected.severity
        || advisory.url !== `https://github.com/advisories/${expected.advisory}`
      ) {
        throw new Error(`Unaccepted ${name} advisory; only ${expected.advisory} is allowed`);
      }
    } else if (!sameStrings(details.via, expected.via)) {
      throw new Error(`Unexpected dependency chain for ${name}`);
    }
  }

  return expectedNames;
}

function evaluateAuditResult(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`npm audit failed to run: ${result.error?.message || result.signal || `exit ${result.status}`}`);
  }
  if (!result.stdout) {
    throw new Error(`npm audit produced no JSON output${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('npm audit returned invalid JSON');
  }

  const accepted = validateReport(report);
  if (result.status === 0 && accepted.length > 0) {
    throw new Error('npm audit reported vulnerabilities with a success exit code');
  }
  if (result.status === 1 && accepted.length === 0) {
    throw new Error('npm audit failed without reporting vulnerabilities');
  }
  return accepted;
}

function main() {
  try {
    const accepted = evaluateAuditResult(spawnSync('npm', ['audit', '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }));
    for (const name of accepted) {
      const { severity, advisory } = EXPECTED_CHAIN[name];
      console.log(`[audit] accepted ${severity} chain record: ${name}${advisory ? ` (${advisory})` : ''}`);
    }
    console.log(`[audit] ${accepted.length} accepted vulnerability records; no unaccepted advisories`);
  } catch (error) {
    console.error(`[audit] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { ADVISORY_ID, evaluateAuditResult, validateReport };
