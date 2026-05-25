# Privacy Policy

**Last updated: May 21, 2026**

This Privacy Policy describes how the Roubo OAuth App ("Roubo for Github") and the Roubo desktop application handle your information.

## Summary

Roubo runs entirely on your computer. It has no servers, no hosted backend, no analytics, no crash reporting, and no telemetry. The Roubo project does not collect, store, transmit, or have access to any of your data. Your GitHub access token, and any GitHub data Roubo reads or writes on your behalf, stay on your machine and are exchanged only between your machine and GitHub.

## Who this policy covers

This policy applies to the "Roubo for Github" OAuth App and to the Roubo desktop application that uses it. Roubo is open source software. Throughout this document, "Roubo" or "the Roubo project" refers to the maintainers of the open source repository at [github.com/davidpoxon/roubo](https://github.com/davidpoxon/roubo), and "you" refers to the person installing and using Roubo.

## What Roubo is

Roubo is a local development environment manager. The Roubo application runs as a process on your own computer. The "Roubo for Github" OAuth App exists solely so that the Roubo application on your machine can call the GitHub API on your behalf, using a token issued to you by GitHub.

## Information Roubo collects

We do not collect any information.

There is no Roubo-operated server, database, log sink, analytics provider, error tracker, or other infrastructure that receives data from your installation. The Roubo project has no way to read your token, your code, your repositories, your issues, your pull requests, or any other data on your account.

## Information Roubo stores on your computer

When you authenticate, Roubo stores the following locally in `~/.roubo/`:

- Your GitHub OAuth access token
- Your GitHub username (the `login` returned by GitHub for your account)
- The OAuth scopes that were granted
- The timestamp at which authorization completed

The token file (`~/.roubo/auth.json`) is written with owner-only file permissions (mode `0600`), following the same pattern used by tools like git's credential helpers. Roubo never transmits this file off your machine. The token is sent only in the `Authorization` header of HTTPS requests made by your local Roubo installation to GitHub.

Roubo also stores local state about your registered projects, benches, and configuration in `~/.roubo/`, and creates git worktrees under `~/.roubo/workspaces/`. None of this state is transmitted anywhere.

## GitHub permissions Roubo requests

When you authorize "Roubo for Github", GitHub will ask you to grant the following OAuth scopes:

- **`repo`**: lets Roubo read and write the issues, pull requests, branches, labels, and metadata of repositories your GitHub account can access. Roubo only ever touches repositories you have explicitly registered as projects in the local app.
- **`read:org`**: lets Roubo read your organization memberships. This is required by GitHub in order to enumerate GitHub Projects (v2) that live under an organization you belong to.
- **`read:project`**: lets Roubo read GitHub Projects (v2), so it can list issues from a linked project and read project metadata such as fields and issue types.
- **`security_events`**: lets Roubo read GitHub code-scanning alerts for the repositories you have registered as projects, so they can be surfaced inside the local app.

Roubo does not request any other scopes (for example, it does not request `delete_repo`, `admin:org`, `user:email`, `workflow`, or any GitHub App equivalents).

## How Roubo uses these permissions

The Roubo application, running on your computer, uses your token to call the GitHub REST and GraphQL APIs at `api.github.com` and `github.com`. Typical calls include:

- Reading metadata for repositories you have registered as projects.
- Listing and reading issues, pull requests, labels, and comments for those repositories.
- Reading GitHub Projects (v2) data linked to those projects.
- Creating or updating issues and pull requests in response to actions you take inside Roubo.

Every API call is initiated by you, either explicitly or through a workflow you have started inside the Roubo application, and goes directly from your machine to GitHub. The Roubo project never sees these requests or their responses.

## Third parties

The only third party involved is GitHub itself. Your interactions with the GitHub API are governed by [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) and [GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service). Roubo does not share data with any other third party, because there is no Roubo infrastructure from which it could.

## Revoking access

You can revoke Roubo's access to your GitHub account at any time:

- Inside Roubo, disconnect the GitHub connection from the application's settings. This deletes `~/.roubo/auth.json` from your computer.
- On GitHub, visit [Settings → Applications → Authorized OAuth Apps](https://github.com/settings/applications), find "Roubo for Github", and revoke it. This invalidates the token immediately on GitHub's side, regardless of any local copy.

For a complete reset, do both. You can also delete the `~/.roubo/` directory at any time to remove every piece of locally stored Roubo data, including registered projects, bench state, and your token.

## Security

Your OAuth token is stored in a file readable only by your operating system user account. As with any locally stored credential (such as the keys in `~/.ssh/` or the cache used by your git credential helper), anyone with administrative or physical access to your computer could in principle read that file. We recommend keeping disk encryption enabled and following normal account-level security practices on your machine.

If you discover a security issue in Roubo, please report it by opening an issue at [github.com/davidpoxon/roubo/issues](https://github.com/davidpoxon/roubo/issues). For sensitive reports where coordinated disclosure is appropriate, please indicate that in the issue title and request a private channel before sharing details.

## Children's privacy

Roubo is a developer tool and is not directed to children under 13. Because Roubo collects no information of any kind, no children's data is collected.

## Changes to this policy

If this policy changes in a way that affects what data Roubo touches or how it is handled, the "Last updated" date at the top of this document will be revised and the change will be noted in the project's release notes. Material changes will also be summarized in the README and in the "Roubo for Github" OAuth App listing description.

## Contact

For any questions about this Privacy Policy or about Roubo's handling of your data, please open an issue at [github.com/davidpoxon/roubo/issues](https://github.com/davidpoxon/roubo/issues).
