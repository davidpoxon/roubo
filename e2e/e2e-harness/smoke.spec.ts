import { expect, test } from "@playwright/test";

// Proves the IP-WU-062 harness is wired end-to-end before IP-WU-064 lands the real
// IP-TC-175 spec under this same directory:
//   - POST /test/__reset (IP-WU-061, IP-FR-079) responds 200, which can only happen
//     when the built server is up and ROUBO_E2E=1 is in scope.
//   - The built server serves the built client shell via express.static.

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/test/__reset");
  expect(reset.status()).toBe(200);
});

test("built server serves the client shell under ROUBO_E2E=1", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('id="root"');
});
