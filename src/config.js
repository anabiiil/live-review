import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * @typedef {{publicHost:string, resendApiKey:string, fromEmail:string, ownerName:string,
 *   ownerEmail:string, tunnelName:string, publicPort:number, adminPort:number}} Config
 */

/** @returns {Config} */
const defaults = () => ({
  publicHost: '',
  resendApiKey: '',
  fromEmail: '',
  ownerName: '',
  ownerEmail: '',
  tunnelName: '',
  publicPort: 4317,
  adminPort: 4318,
});

/** @returns {string} Absolute path of the LiveReview data directory. */
export function dataDir() {
  const override = process.env.LIVEREVIEW_DATA_DIR;
  if (override) return override;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'LiveReview');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'LiveReview');
  }
  return join(homedir(), '.config', 'livereview');
}

const configPath = () => join(dataDir(), 'config.json');

/**
 * Defaults merged with config.json. Throws (naming the file) if it is malformed.
 * @returns {Config}
 */
export function loadConfig() {
  const file = configPath();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return defaults();
    throw new Error(`Cannot read config file ${file}: ${/** @type {Error} */ (err).message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Config file ${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${file} must contain a JSON object`);
  }
  return { ...defaults(), ...parsed };
}

/**
 * Merge `partial` into the stored config and write it atomically (mode 0600: it holds the API key).
 * @param {Partial<Config>} partial
 * @returns {Config}
 */
export function saveConfig(partial) {
  const merged = { ...loadConfig(), ...partial };
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = configPath();
  const tmp = join(dir, `.config.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return merged;
}

/**
 * @param {Config} cfg
 * @returns {boolean}
 */
export function isConfigured(cfg) {
  // Email (Resend key + sender) is optional: invite links work without it.
  return Boolean(cfg.publicHost && cfg.ownerName && cfg.ownerEmail);
}
