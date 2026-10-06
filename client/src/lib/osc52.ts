/**
 * Parses the payload of an agent-initiated `OSC 52 ; <Pc> ; <Pd> ST` clipboard
 * sequence, in the form xterm hands to a registered OSC handler: everything
 * after `OSC 52 ;`, reassembled across however many PTY chunks the sequence
 * arrived in, with the BEL/ST terminator already stripped.
 *
 * xterm.js core registers OSC handlers for 0, 1, 2, 4, 8, 10-12 and 104,
 * 110-112, but not 52, so without a registered handler this payload is
 * parsed and silently discarded: an agent's clipboard write never reaches the
 * host. This parser is write-only by design. A `?` read query is recognised
 * and deliberately never answered, so a process in a bench cannot read back
 * whatever the user last copied on the host.
 */

/** The clipboard selections this parser accepts in the `Pc` field. */
const ACCEPTED_SELECTIONS = new Set(["", "c", "p", "s"]);

/**
 * Decoded bytes accepted from a single OSC 52 write. A denial-of-service
 * bound, not a usability one: 256 KiB is far more than the code, diffs, or
 * command output a "copy this" request produces.
 */
export const OSC52_MAX_DECODED_BYTES = 256 * 1024;

/** Four base64 characters carry three bytes, so this bounds the decode without doing it. */
const MAX_BASE64_CHARS = Math.ceil(OSC52_MAX_DECODED_BYTES / 3) * 4;

export type Osc52Result =
  { kind: "write"; text: string } | { kind: "query" } | { kind: "unhandled" };

export function parseOsc52(payload: string): Osc52Result {
  const sep = payload.indexOf(";");
  if (sep === -1) return { kind: "unhandled" };
  const selection = payload.slice(0, sep);
  // Pd is base64, so it never contains a further `;` and one split is enough.
  const data = payload.slice(sep + 1);

  // The web has a single clipboard, so clipboard (c), primary (p) and select
  // (s) all land in the same place, and an empty field is xterm's documented
  // default of s0. The cut buffers (0-7) and the secondary selection (q) have
  // no web equivalent and are left unhandled rather than quietly aliased onto
  // the one clipboard the user actually pastes from.
  if (!ACCEPTED_SELECTIONS.has(selection)) return { kind: "unhandled" };

  if (data === "?") return { kind: "query" };

  // An empty Pd is the spec's "clear the clipboard". Not honoured: an agent
  // must not be able to wipe what the user copied, and no agent needs to.
  if (data.length === 0 || data.length > MAX_BASE64_CHARS) return { kind: "unhandled" };

  const text = decodeBase64Utf8(data);
  if (text === null) return { kind: "unhandled" };
  return { kind: "write", text };
}

function decodeBase64Utf8(data: string): string | null {
  try {
    // `atob` yields one character per byte (Latin-1), so the bytes have to be
    // lifted back out and decoded as UTF-8. Reading the `atob` result as the
    // text directly mangles every non-ASCII character an agent copies.
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // Malformed base64 from the PTY. This runs inside xterm's write loop, so
    // throwing here would take out the rest of the frame's output.
    return null;
  }
}
