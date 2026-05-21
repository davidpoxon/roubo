# Contributing to Roubo

Thanks for your interest in contributing to Roubo. This document covers how to
report issues, set up your development environment, and submit changes.

## Code of conduct

Be respectful. Engage with the work, not the person. Disagreements about
direction are normal; treat them as a way to find the better answer, not a
contest to win.

## Reporting issues

Before opening an issue, search existing issues to avoid duplicates. When
filing a new issue, include:

- What you were trying to do.
- What happened instead.
- Your environment (OS, Node.js version, Roubo version).
- Reproduction steps, if possible.

For security issues, do not open a public issue. Email <security@roubo.dev>
directly.

## Suggesting changes

Open an issue describing the change you'd like to make before starting
significant work. This avoids the situation where a PR arrives that
doesn't fit Roubo's direction and has to be turned away after you've
already done the work.

Small fixes (typos, obvious bugs, documentation polish) don't need a
prior issue. Just open the PR.

## Development setup

See [docs/development.md](docs/development.md) for setup, build, and
dev-server instructions. See [docs/architecture.md](docs/architecture.md)
for how Roubo is put together, and [CLAUDE.md](CLAUDE.md) for the working
conventions enforced in review. Before opening a PR:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
```

These match what CI runs. Failing any of them locally means CI will fail
too.

## Brand and vocabulary

Roubo uses a specific vocabulary: bench, project, component, tool,
inspection, blueprint, workspace. UI text, error messages, and
user-facing documentation must use these terms. See
[docs/brand.md](docs/brand.md) for the full guide. Contributions that
introduce competing vocabulary will be asked to align before merging.

## Developer Certificate of Origin (DCO)

Every commit in a pull request must be signed off under the [Developer
Certificate of Origin](https://developercertificate.org/) (DCO). This is a
lightweight declaration that you wrote the change, or have the right to
contribute it under Roubo's licence (Apache 2.0). The full text is below.

The DCO is enforced automatically. A pull request with any unsigned
commits will be blocked from merging until every commit is signed off.

### How to sign off

Add the `-s` flag to your commit command. Git will append a
`Signed-off-by:` line to the commit message using your configured name and
email:

```bash
git commit -s -m "Brief description of the change"
```

The line looks like:

```
Signed-off-by: Your Name <you@example.com>
```

If you commit through an IDE or tool that doesn't surface the `-s` flag,
the equivalent is to append a `Signed-off-by:` line to the commit message
yourself, matching the email on the commit. The git CLI does this for you
when you pass `-s`.

### Bot exemption

Automated dependency-update bots (currently Dependabot) are exempt from
the per-commit sign-off requirement. The DCO is an attestation of human
authorship; a bot cannot meaningfully attest to that. The allowlist of
exempt author emails lives in [.github/workflows/dco.yml](.github/workflows/dco.yml).

### If you forgot to sign off

The DCO check on your pull request will fail with the specific commits
that are missing sign-off. Fix it with one of the following.

**For the most recent commit only:**

```bash
git commit --amend --no-edit --signoff
git push --force-with-lease
```

**For multiple commits in the pull request:**

```bash
git rebase --signoff origin/main
git push --force-with-lease
```

Replace `origin/main` with whatever the base branch of your pull request
is, if different.

Force-pushing to a pull request branch is expected and safe. It
re-triggers CI and the DCO check.

### Full DCO text

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project and the open source license(s) involved.
```

## Pull request process

1. Fork the repository and create a feature branch from `main`.
2. Make your changes, with tests where applicable. Roubo's CI enforces
   80% coverage on lines, functions, branches, and statements.
3. Sign off each commit (see DCO above).
4. Run the local checks listed under [Development setup](#development-setup).
5. Open a pull request against `main`. Fill in the PR template.
6. Address review feedback. Force-pushes to update the PR branch are
   expected.
7. A maintainer will merge once CI passes and the change has been
   approved.

Roubo follows a "main is always green" policy: every commit on `main`
must pass CI. PRs are merged via squash by default, with the PR title as
the squash commit message.

## Licensing of contributions

By submitting a contribution, you agree that it is licensed under the
[Apache License, Version 2.0](LICENSE), the same licence that covers
Roubo's existing source. You retain copyright in your contribution. The
DCO sign-off is your assertion that you have the right to make this
licensing grant.

The name "Roubo" and the Roubo logomark are trademarks and are governed
by [TRADEMARK.md](TRADEMARK.md), not by the Apache 2.0 licence.

## Questions

For anything not covered here, open an issue or email
<contributing@roubo.dev>.
