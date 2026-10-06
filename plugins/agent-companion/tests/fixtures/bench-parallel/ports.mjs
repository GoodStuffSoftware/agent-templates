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

// An OS-assigned port that stays HELD until the code under test is about to
// bind it: hand `release` to the fixture to await right before its own
// listen(), so the only exposure is the microtask gap between the two
// rather than the whole of a test's setup. `release` is idempotent, so a
// test can also call it in `finally` to cover the paths where the fixture
// never binds.
export async function reservePort() {
  const server = await listenEphemeral();
  const port = portOf(server);
  let released = null;
  const release = () => {
    if (!released) released = closeServer(server);
    return released;
  };
  return { port, release };
}
