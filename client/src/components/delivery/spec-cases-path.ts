// The case file of a Spec Bench's spec (#1653).

/**
 * The test-cases.json path of a Spec Bench's spec. A Spec Bench records its
 * spec folder as its focused spec path, but the TestBench panel reads the slug
 * from a path to the case file, as a TestBench bench records it.
 */
export function specCasesPath(specFolder: string | undefined): string | undefined {
  if (specFolder === undefined || specFolder.length === 0) return undefined;
  return specFolder.endsWith("/test-cases.json")
    ? specFolder
    : `${specFolder.replace(/\/+$/, "")}/test-cases.json`;
}
