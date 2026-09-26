# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/malhashemi/opencode-dynamic-workflows/security/advisories/new),
not in a public issue. Include steps to reproduce and the version you tested.

You can expect an acknowledgement within a few days. Once a fix is ready, it ships in a release and the advisory is
published with credit to you, unless you prefer otherwise.

## Scope

The trust model is described in [docs/security.md](packages/plugin/docs/security.md). Areas where a flaw would matter
most:

- **The inline-Workflow approval.** Model-written Workflows run with the user's privileges once approved. A way to run
  one without an approval (or a project/plugin setting that allows it) is a vulnerability.
- **The Gateway.** It serves the protocol and the web app over HTTP. Host and Origin checks, bearer tokens for control
  actions, pairing codes and token storage are in scope. A way to control Runs, or read them from another machine,
  without a token is a vulnerability.
- **Capability confinement.** `ctx.file` and the working directory of `ctx.$` must stay inside the project, through
  symlinks. An escape is a vulnerability (a script that simply imports `node:fs` is not: that is the trust model).
- **Unit permissions.** Engine rules and the permission policy must not let a Unit run a tool the user's rules and the
  Workflow's rules deny, and a headless Run must not hang on a permission.

## Supported versions

Security fixes go into the latest release.
