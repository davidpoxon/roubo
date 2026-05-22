// Reference plugin for TC-035. Exercises every SDK affordance the contract
// gives a plugin author: contract methods, host.credentials, host.fetch,
// and host.logger.

import { definePlugin, host } from "@roubo/plugin-sdk";

definePlugin({
  async getCurrentUser() {
    let token = null;
    try {
      token = await host.credentials.get("reference-token");
    } catch (err) {
      host.logger.warn({ message: "credentials.get failed", data: { error: String(err) } });
    }
    host.logger.info({ message: "getCurrentUser called", data: { hasToken: token !== null } });
    return {
      externalId: token ?? "anonymous",
      displayName: token ? "Reference User" : "Anonymous",
    };
  },
  async listIssues({ cursor, pageSize }) {
    const target = process.env.SDK_REFERENCE_FETCH_URL ?? "http://127.0.0.1:0/issues";
    const res = await host.fetch(`${target}?cursor=${cursor ?? ""}&pageSize=${pageSize}`);
    const body = typeof res.body === "string" ? res.body : Buffer.from(res.body).toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { items: [], nextCursor: null };
    }
    return { items: parsed.items ?? [], nextCursor: parsed.nextCursor ?? null };
  },
  async validateConfig() {
    host.logger.warn("validateConfig is a no-op in the reference fixture");
    return { ok: true };
  },
});
