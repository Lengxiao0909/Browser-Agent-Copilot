import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const currentDir = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(currentDir, '../../../../.env')
];

for (const path of candidates) {
  if (existsSync(path)) {
    config({ path, override: false });
  }
}
