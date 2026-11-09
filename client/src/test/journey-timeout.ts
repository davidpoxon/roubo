// The timeout of a Spec Bench journey test (#1636). A journey drives a real
// server and the whole Delivery tab, so on `main` CI the slowest take about
// 4 s, which leaves little of the 5 s default on a slow runner. This gives
// each one over three times its CI time.
export const JOURNEY_TIMEOUT_MS = 15_000;
