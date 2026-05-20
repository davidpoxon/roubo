# Roubo Transparency Disclosures

## Architecture and security

Roubo is open-source software that runs entirely on the developer's local machine. There is no Roubo-operated backend, database, log sink, telemetry pipeline, or hosted inference service. The "Roubo for Github" OAuth App exists only so the local app can call the GitHub API on the user's behalf.

- The OAuth token is stored at `~/.roubo/auth.json` with mode `0600` (owner-only).
- All GitHub API traffic goes directly from the user's machine to `api.github.com` over HTTPS.
- No code, repository content, issue or PR data, or token material is transmitted to any Roubo-controlled endpoint, because none exists.
- Full source is auditable at github.com/davidpoxon/roubo.

## OAuth scope minimisation

Roubo requests only `repo`, `read:org`, and `read:project`. It does not request `delete_repo`, `admin:org`, `user:email`, `workflow`, or other administrative scopes. Scopes are used only to read and update issues, pull requests, branches, labels, and Projects (v2) for repositories the user has registered as projects.

## Risk management and safety

Roubo can launch AI coding agents inside isolated git worktrees ("benches") locally. Safety controls:

- Per-project tool permission lists, defined by the user and injected into each bench at creation.
- Worktree isolation: agent activity is confined to a dedicated worktree, not the main checkout.
- Local-only execution: agent processes, file writes, and shell commands run under the user's OS account.
- Explicit user initiation: every GitHub-affecting action is initiated by the user; Roubo never acts autonomously on a schedule.

## Data governance

Because no personal data is collected, transmitted, or stored by the Roubo project, no controller-processor relationship arises under GDPR, CCPA, or analogous regimes. The user remains the sole controller of any data on their machine and of any data exchanged with GitHub (governed by GitHub's Privacy Statement).

## EU AI Act classification

Roubo is not itself an AI system within the meaning of Article 3 of the EU AI Act; it is a local orchestrator that the user may configure to launch third-party AI coding agents. It performs no profiling, biometric identification, employment, education or law-enforcement decisioning, critical-infrastructure control, or any other use case listed in Annex III. Roubo is therefore not "high-risk" under Article 6, and the obligations in Articles 8 to 17 do not apply. Obligations on any third-party AI coding agent rest with its provider; Roubo passes the user's permission rules to the agent unmodified.

## Compliance certifications

The Roubo project holds no formal third-party certifications (SOC 2, ISO 27001, HIPAA, FedRAMP, etc.), reflecting the architecture: there is no hosted service to certify. The full source, including the OAuth flow and token-handling code, is publicly auditable.

## Contact

Security or compliance questions: github.com/davidpoxon/roubo/issues
