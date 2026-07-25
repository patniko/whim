# Releasing whim

Releases remain manually triggered from the **Release** GitHub Actions workflow.
The input tag must already exist and must match the `version` in `package.json`
(for example, package version `0.0.17` requires tag `v0.0.17`).

## Required repository secrets

macOS signing and notarization:

- `MACOS_CERTIFICATE`
- `MACOS_CERTIFICATE_PWD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Windows Trusted Signing:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`

The release workflow validates the tag, checked-out commit, version, and all
required secret inputs before building. It then creates and inspects an unsigned
macOS package before the existing signed macOS and Windows publish jobs run. The
package smoke check verifies the app executable, resources, native SQLite module,
and the platform-specific bundled Copilot runtime. The preflight publishes the
validated commit SHA, and every build/publish job checks out that immutable SHA
rather than resolving the tag again.

## Local confidence checks

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run audit:dependencies
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
npm run smoke:package -- --platform mac
```

## Accepted dependency advisory

As of 2026-07-20, `npm audit` reports the `adm-zip` memory-allocation advisory
(`GHSA-xcpc-8h2w-3j85`) through `onnxruntime-node`, and consequently through
`@huggingface/transformers`. The published `onnxruntime-node` versions compatible
with the current inference stack still depend on an affected `adm-zip`; npm's
suggested fix is a breaking downgrade to `onnxruntime-node@1.21.1`.

This is accepted temporarily because whim does not use `onnxruntime-node` to
extract untrusted ZIP archives. `npm run audit:dependencies` fails CI for any
advisory outside this explicitly acknowledged dependency chain.
