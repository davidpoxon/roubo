"use strict";

const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

connection.onRequest("invokeHost", async (params) => {
  try {
    const result = await connection.sendRequest(params.method, params.payload);
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: { code: err && err.code, message: err && err.message, data: err && err.data },
    };
  }
});

connection.listen();
