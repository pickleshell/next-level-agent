#!/usr/bin/env node
// Read-only SQLite event stream. No migrations, provider calls or file mirror.
import path from 'node:path';
import os from 'node:os';
import { executionStatus } from '../.opencode/plugins/nla-execution-store.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/nla-events.mjs [--follow] [--runtime] [--database /path/system.sqlite] [--task ID] [--root SESSION] [--after SEQUENCE]');
} else {
  const file = option('--database') || path.join(process.env.NLA_MEMORY_DIR || path.join(os.homedir(), '.local/share/nla'), 'system.sqlite');
  let cursor = Number(option('--after') || 0), stopped = false;
  process.on('SIGINT', () => { stopped = true; });
  process.on('SIGTERM', () => { stopped = true; });
  try {
    do {
      const rows = executionStatus(file, { action: args.includes('--runtime') ? 'log' : 'recent', root: option('--root'), task: option('--task'), after: cursor, limit: 200 });
      for (const row of rows) { console.log(JSON.stringify(row)); cursor = row.sequence; }
      if (rows.length === 200) continue;
      if (!args.includes('--follow') || stopped) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (!stopped);
  } catch (error) { console.error(`NLA event reader: ${error.code || error.name}; database unavailable or not migrated. No state changed.`); process.exitCode = 1; }
}
