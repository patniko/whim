const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const releaseWorkflow = yaml.load(
  fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8'),
);

function checkoutRef(jobName) {
  const checkout = releaseWorkflow.jobs[jobName].steps.find((step) => step.uses === 'actions/checkout@v4');
  return checkout?.with?.ref;
}

test('release preflight exports the validated commit SHA', () => {
  assert.equal(
    releaseWorkflow.jobs.preflight.outputs.commit_sha,
    '${{ steps.release-preflight.outputs.commit_sha }}',
  );
  assert.equal(checkoutRef('preflight'), '${{ inputs.tag }}');
});

test('every downstream release checkout uses the immutable preflight SHA', () => {
  const immutableRef = '${{ needs.preflight.outputs.commit_sha }}';
  for (const job of ['validate-mac-package', 'release-mac', 'release-win']) {
    assert.equal(checkoutRef(job), immutableRef, `${job} must check out the validated SHA`);
  }
});
