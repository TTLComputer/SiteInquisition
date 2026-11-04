import { homedir } from 'node:os';
import { join } from 'node:path';

/** Per-user data directory: holds the CA and app settings, never project data. */
export function defaultDataDir(): string {
  if (process.env.SIQ_DATA_DIR) return process.env.SIQ_DATA_DIR;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'SiteInquisition');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'siteinquisition');
}
