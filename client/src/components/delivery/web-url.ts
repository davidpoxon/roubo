// Only an http(s) URL becomes a link: a `pr_url` in the delivery record is a
// string the session writes.
export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
