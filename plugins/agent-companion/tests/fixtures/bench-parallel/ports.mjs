// OS-assigned loopback ports for the bench-parallel fixtures and the tests
// that drive them. Several test processes run at once on one machine (the
// suite's own --test-concurrency, and other worktrees' pre-push runs), so a
// hardcoded port number is shared machine-wide and collides across them.
// listen(0) lets the OS hand each test process a port no one else holds.
import net from "node:net";

// Binds an OS-assigned port on 127.0.0.1 and KEEPS it bound. Use this when
// the test wants the port held (a "holder" squatting it) -- the port is
// read from the live server, so there is no window where another process
// could take it first.
export function listenEphemeral() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

export function portOf(server) {
  return server.address().port;
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// An OS-assigned port that is free right now, released before returning so
// the code under test can bind it itself. Unlike a hardcoded number, no
// other test process is configured to use it; the only exposure is the OS
// reissuing the same ephemeral port to someone else in the short gap before
// the caller binds it. Prefer listenEphemeral() when the test can hold it.
export async function freePort() {
  const server = await listenEphemeral();
  const port = portOf(server);
  await closeServer(server);
  return port;
}
