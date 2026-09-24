// Standalone child process for subprocess-collision-catching-task.mjs.
// Binds the port given as argv[2]; exits 0 if it can, non-zero (and prints
// the real net error code to stderr) if it can't -- e.g. EADDRINUSE when
// something else already holds it. This is what makes the parent hidden
// test's collision genuine: a REAL OS-level bind failure in a REAL separate
// process, not a simulated one.
import net from "node:net";

const port = Number(process.argv[2]);
const srv = net.createServer();
srv.on("error", (e) => {
  process.stderr.write(`subprocess-bind-child: bind failed: ${e.code}: ${e.message}\n`);
  process.exit(1);
});
srv.listen(port, "127.0.0.1", () => {
  srv.close(() => process.exit(0));
});
