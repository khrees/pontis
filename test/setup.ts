import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const testDir = join(tmpdir(), 'pontis-test-' + process.pid);
mkdirSync(testDir, { recursive: true });
process.env.PONTIS_DIR = testDir;
