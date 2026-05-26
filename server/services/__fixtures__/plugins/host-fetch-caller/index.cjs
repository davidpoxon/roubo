"use strict";

const rpc = require("vscode-jsonrpc/node");

const reader = new rpc.StreamMessageReader(process.stdin);
const writer = new rpc.StreamMessageWriter(process.stdout);
const connection = rpc.createMessageConnection(reader, writer);

function serializeError(err) {
  if (!err) return { message: String(err) };
  return {
    message: err.message,
    code: err.code,
    data: err.data,
  };
}

connection.onRequest("fetch", async (params) => {
  try {
    const value = await connection.sendRequest("host.fetch", {
      url: params.url,
      init: params.init,
    });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
});

connection.listen();
