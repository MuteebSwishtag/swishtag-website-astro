import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

export class AuditLog {
  constructor(filename) { this.filename = filename; this.pending = Promise.resolve(); }
  async append(entry) {
    const record = { at: new Date().toISOString(), ...entry };
    // Single process writes in order; do not record tokens, source contents or WP bodies.
    const write = this.pending.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      await appendFile(this.filename, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    });
    this.pending = write; await write;
  }
}
