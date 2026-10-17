// Preload (node --import) that makes this process look like a GitHub-hosted
// Linux runner: 4 logical cores, real non-zero load averages, and cpu times
// that show 3 of the 4 cores busy. Windows reports loadavg() as zeros and the
// operator box has 32 cores, so a test that leaks real machine state can pass
// there and fail on CI; ci-budget-small-host.test.mjs runs the ci-budget suites
// under this preload to catch that here.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const CORES = 4;
let tick = 0;
const fakeCpus = () => {
  tick += 1;
  return Array.from({ length: CORES }, (_, i) => {
    const busy = i < 3;
    return {
      model: 'fake runner cpu', speed: 2400,
      times: { user: busy ? 1000 * tick : 0, nice: 0, sys: 0, idle: busy ? 0 : 1000 * tick, irq: 0 },
    };
  });
};

os.availableParallelism = () => CORES;
os.cpus = fakeCpus;
os.loadavg = () => [3.4, 3.1, 2.9];
syncBuiltinESMExports();
