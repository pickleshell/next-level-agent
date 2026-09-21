#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { preflightModelPools, resolveModelPools } from '../.opencode/plugins/nla-model-pools.mjs';

function usage() {
  return 'Usage: node scripts/nla-model-pools-preflight.mjs [--pools /absolute/path.json] [--available-models /absolute/path.json]';
}

function readInventory(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Could not read supplied runtime inventory ${file}: ${error.message}`); }
  const models = Array.isArray(parsed) ? parsed : parsed?.models;
  if (!Array.isArray(models)) throw new Error('Supplied runtime inventory must be a JSON array or an object with a models array');
  return models;
}

const args = process.argv.slice(2);
let poolsPath = null;
let inventoryPath = null;
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--help' || value === '-h') { console.log(usage()); process.exit(0); }
  if (!['--pools', '--available-models'].includes(value) || !args[index + 1]) {
    console.error(usage()); process.exit(2);
  }
  if (value === '--pools') poolsPath = args[++index];
  else inventoryPath = args[++index];
}

try {
  const resolved = resolveModelPools({ explicitPath: poolsPath });
  const result = preflightModelPools(resolved, inventoryPath ? readInventory(path.resolve(inventoryPath)) : undefined, resolved.source);
  console.log(`NLA model-pool preflight passed: ${result.roles} roles; runtime inventory ${result.checkedAvailability ? 'matched' : 'not supplied (syntax only)'}.`);
} catch (error) {
  console.error(`NLA model-pool preflight failed: ${error.message}`);
  process.exitCode = 1;
}
