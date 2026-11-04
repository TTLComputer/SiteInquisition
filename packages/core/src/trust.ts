import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Scripts the user has allowed to run without the sandbox, on this computer.
 *
 * A project folder can come from someone else, so a script saved with
 * `sandbox: false` only runs unsandboxed after the user saves or trusts
 * that exact code here. The list lives in the per-user data folder (never
 * in the project), keyed by a hash of the project folder and the code, so
 * editing the code or copying the project elsewhere asks again.
 */
export class TrustedScripts {
  private readonly file: string;
  private hashes: Set<string>;

  constructor(
    dataDir: string,
    private readonly projectDir: string,
  ) {
    this.file = join(dataDir, 'trusted-scripts.json');
    this.hashes = new Set(this.read());
  }

  private read(): string[] {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private key(code: string): string {
    return createHash('sha256').update(this.projectDir).update('\0').update(code).digest('hex');
  }

  has(code: string): boolean {
    return this.hashes.has(this.key(code));
  }

  add(code: string): void {
    const k = this.key(code);
    if (this.hashes.has(k)) return;
    // Another project may have added entries since this one started.
    this.hashes = new Set([...this.read(), ...this.hashes, k]);
    mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify([...this.hashes]), { mode: 0o600 });
  }
}
