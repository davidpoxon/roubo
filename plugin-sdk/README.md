# @roubo/plugin-sdk

Plugin author SDK for Roubo integration plugins. Provides `definePlugin` and a `host` client so plugin code talks to Roubo's JSON-RPC protocol without writing any framing.

```ts
import { definePlugin, host } from "@roubo/plugin-sdk";

definePlugin({
  async getCurrentUser() {
    const token = await host.credentials.get("api-token");
    const res = await host.fetch("https://api.example.com/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    const user = JSON.parse(res.body as string);
    return { externalId: user.id, displayName: user.name };
  },
  async listIssues({ cursor, pageSize }) {
    return { items: [], nextCursor: null };
  },
});
```

Full author docs, including the manifest format, every contract method, pagination, error shapes, host helpers, and the trust model, live at [`docs/plugin-sdk.md`](../docs/plugin-sdk.md) in the Roubo repo.
