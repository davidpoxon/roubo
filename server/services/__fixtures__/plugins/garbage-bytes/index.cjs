"use strict";

// Write a malformed Content-Length frame to provoke a parse error in the host.
const garbage = "Content-Length: 99999\r\n\r\n!!! not json !!!\n";
process.stdout.write(garbage);

// Keep alive so the host can attempt subsequent calls and verify the child is still running.
setInterval(() => {}, 1_000_000);
