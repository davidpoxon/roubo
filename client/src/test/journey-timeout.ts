// The timeout of a Spec Bench journey test (#1636). A journey drives a real
// server and the whole Delivery tab, so on `main` CI the slowest under the 5 s
// default take about 4 s, which leaves little margin on a slow runner. This
// gives each one over three times its CI time. A journey that sets its own
// longer timeout on its `it` (review, gate sitting, lifecycle) keeps it and
// does not use this.
export const JOURNEY_TIMEOUT_MS = 15_000;
