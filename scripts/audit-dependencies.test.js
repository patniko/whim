const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAuditResult } = require('./audit-dependencies');

function acceptedReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
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
        via: [{
          name: 'adm-zip',
          dependency: 'adm-zip',
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-xcpc-8h2w-3j85',
        }],
        effects: ['onnxruntime-node'],
      },
      sharp: {
        severity: 'high',
        isDirect: false,
        via: [{
          name: 'sharp',
          dependency: 'sharp',
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-f88m-g3jw-g9cj',
        }],
        effects: ['@huggingface/transformers'],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 4, critical: 0, total: 4 },
    },
  };
}

test('accepts only the expected advisory and dependency chain', () => {
  const accepted = evaluateAuditResult({ status: 1, stdout: JSON.stringify(acceptedReport()) });
  assert.deepEqual(accepted.sort(), ['@huggingface/transformers', 'adm-zip', 'onnxruntime-node', 'sharp'].sort());
});

test('rejects a different advisory for an allowlisted package', () => {
  const report = acceptedReport();
  report.vulnerabilities['adm-zip'].via[0].url = 'https://github.com/advisories/GHSA-0000-0000-0000';
  assert.throws(
    () => evaluateAuditResult({ status: 1, stdout: JSON.stringify(report) }),
    /only GHSA-xcpc-8h2w-3j85 is allowed/,
  );
});

test('rejects a different advisory for sharp', () => {
  const report = acceptedReport();
  report.vulnerabilities.sharp.via[0].url = 'https://github.com/advisories/GHSA-0000-0000-0000';
  assert.throws(
    () => evaluateAuditResult({ status: 1, stdout: JSON.stringify(report) }),
    /only GHSA-f88m-g3jw-g9cj is allowed/,
  );
});

test('rejects an altered dependency chain or severity', () => {
  const report = acceptedReport();
  report.vulnerabilities['onnxruntime-node'].severity = 'moderate';
  assert.throws(
    () => evaluateAuditResult({ status: 1, stdout: JSON.stringify(report) }),
    /Unexpected severity/,
  );
});

test('rejects registry errors, invalid JSON, and tool failures', () => {
  assert.throws(
    () => evaluateAuditResult({ status: 1, stdout: JSON.stringify({ error: { summary: 'registry unavailable' } }) }),
    /operational error/,
  );
  assert.throws(
    () => evaluateAuditResult({ status: 1, stdout: 'not json' }),
    /invalid JSON/,
  );
  assert.throws(
    () => evaluateAuditResult({ status: 2, stdout: '{}' }),
    /failed to run/,
  );
});
