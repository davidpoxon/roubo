// Central secret-redaction for anything we write to plugin logs.
//
// Plugin logs are persisted to ~/.roubo/plugins/<id>/logs/current.log and served back over
// the API, so a credential that reaches a log line is both written to disk and exposed to any
// client that reads the logs. This helper is the single chokepoint (called from
// plugin-manager's formatLogLine) that scrubs known secret shapes before a line is written. It
// is deliberately conservative: it only masks values that are unambiguously credentials, so
// ordinary diagnostic text passes through unchanged.

const REDACTED = "[REDACTED]";

// Token shapes we can recognize regardless of surrounding context (e.g. a bare token logged on
// its own). GitHub tokens use a fixed prefix followed by a long base62 body.
const TOKEN_PATTERNS: readonly RegExp[] = [
  // ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server), ghs_ (server-to-server), ghr_ (refresh).
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  // Fine-grained personal access tokens.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
];

/**
 * Replace credential values in `text` with `[REDACTED]`. Safe to call on any string and safe to
 * call more than once (idempotent on already-redacted text).
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Authorization value in JSON-object form: "Authorization":"<scheme> <value>".
  //    Covers any scheme (Bearer, token, Basic) and is case-insensitive on the key.
  out = out.replace(
    /("[Aa]uthorization"\s*:\s*)"[^"]*"/g,
    (_m, prefix) => `${prefix}"${REDACTED}"`,
  );

  // 2. Authorization value in HTTP header-line form: `Authorization: <value>`.
  //    The negative lookahead skips the JSON form already handled above; the value runs to the
  //    end of the line or the next structural delimiter so we never swallow more than the value.
  out = out.replace(
    /\b([Aa]uthorization\s*:\s*)(?!")[^\r\n",}]+/g,
    (_m, prefix) => `${prefix}${REDACTED}`,
  );

  // 3. Any remaining Bearer credential, wherever it appears.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`);

  // 4. Recognizable bare token shapes.
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }

  // 5. Generic credential-bearing JSON keys.
  out = out.replace(
    /("(?:token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*)"[^"]*"/gi,
    (_m, prefix) => `${prefix}"${REDACTED}"`,
  );

  return out;
}
