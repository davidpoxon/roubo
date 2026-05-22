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

connection.onRequest("getCredential", async (params) => {
  try {
    const value = await connection.sendRequest("host.credentials.get", { slot: params.slot });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
});

connection.onRequest("setCredential", async (params) => {
  try {
    await connection.sendRequest("host.credentials.set", {
      slot: params.slot,
      value: params.value,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
});

connection.onRequest("deleteCredential", async (params) => {
  try {
    await connection.sendRequest("host.credentials.delete", { slot: params.slot });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
});

connection.listen();
