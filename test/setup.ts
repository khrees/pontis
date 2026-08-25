import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const testDir = join(tmpdir(), 'pontis-test-' + process.pid);
mkdirSync(testDir, { recursive: true });
process.env.PONTIS_DIR = testDir;

// Tests must be hermetic: clear any Pontis configuration inherited from the
// developer's shell so results never depend on the local environment. A test
// that exercises one of these sets it explicitly (and cleans up after itself).
for (const v of [
  'PONTIS_MODEL',
  'PONTIS_PROVIDER',
  'PONTIS_UPSTREAM_URL',
  'PONTIS_UPSTREAM_FORMAT',
  'PONTIS_HOST',
  'PONTIS_PORT',
]) {
  delete process.env[v];
}
