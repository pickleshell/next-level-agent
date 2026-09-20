#!/usr/bin/env node
// Configure an already installed optional backend; no downloads or privilege changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = { origins: [] };
try {
  if (args.includes('--help')) {
    console.log('node scripts/configure-browser.mjs --model provider/model --origin https://example.com [--origin URL] [--backend-dir DIR] [--config-dir DIR]');
    process.exit(0);
  }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--model', '--origin', '--backend-dir', '--config-dir'].includes(key) || !value || value.startsWith('--')) throw new Error('Invalid arguments; use --help');
    if (key === '--origin') {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Provide an HTTP(S) origin without credentials, path or query');
      options.origins.push(url.origin);
    } else options[key] = value;
  }
  if (!options['--model']?.includes('/') || !options.origins.length) throw new Error('--model and at least one --origin are required');
  const backend = path.resolve(options['--backend-dir'] || path.join(os.homedir(), '.local/share/nla-browser'));
  const require = createRequire(path.join(backend, 'package.json'));
  const cli = path.join(backend, 'node_modules/@playwright/mcp/cli.js');
  const browser = require('playwright').chromium.executablePath();
  fs.accessSync(cli, fs.constants.R_OK); fs.accessSync(browser, fs.constants.X_OK);
  const configDir = path.resolve(options['--config-dir'] || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'nla'));
  const browserFile = path.join(configDir, 'browser.json');
  const poolFile = path.join(configDir, 'model-pools.json');
  // Read existing pools to validate them, but never replace user preferences.
  const poolSource = process.env.NLA_MODEL_POOLS_PATH || (fs.existsSync(poolFile) ? poolFile : path.join(repo, 'config/model-pools.json'));
  const pools = JSON.parse(fs.readFileSync(poolSource, 'utf8'));
  if (!pools.roles || typeof pools.roles !== 'object' || Array.isArray(pools.roles)) throw new Error('Invalid model pools');
  if (fs.existsSync(browserFile) || fs.existsSync(poolFile) || process.env.NLA_MODEL_POOLS_PATH) {
    throw new Error('Existing configuration preserved. See docs/BROWSER.md to add Browser to your existing files.');
  }
  pools.roles.browser = { enabled: true, models: [options['--model']], idle_timeout_ms: 180000 };
  const config = { command: [process.execPath, cli, '--headless', '--isolated', '--executable-path', browser], allowed_origins: [...new Set(options.origins)], timeout_ms: 30000, action_timeout_ms: 5000, max_sessions: 2, session_ttl_ms: 600000 };
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const created = [];
  try {
    for (const [file, value] of [[browserFile, config], [poolFile, pools]]) {
      const fd = fs.openSync(file, 'wx', 0o600); created.push(file);
      try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); } finally { fs.closeSync(fd); }
    }
  } catch (error) { for (const file of created) fs.unlinkSync(file); throw error; }
  console.log(`Created ${browserFile}\nCreated ${poolFile}\nBrowser model: ${options['--model']}\nDirect backend: no OS-level network containment.\nStart: ${repo}/scripts/nla /absolute/path/to/project`);
} catch (error) {
  console.error(`Browser setup: ${error.message}`); process.exitCode = 1;
}
