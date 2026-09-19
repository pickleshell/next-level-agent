import fs from 'node:fs';

// Process cleanup evidence is valid only when the launcher PID is observable.
// Broker session identifiers prove allocation, not ownership of a process tree.
export function processSnapshot(procRoot = '/proc') {
  const result = new Map();
  for (const entry of fs.readdirSync(procRoot).filter(value => Number.isInteger(Number(value)) && String(Number(value)) === value)) {
    try {
      const raw = fs.readFileSync(`${procRoot}/${entry}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      result.set(Number(entry), { pid: Number(entry), state: fields[0], parent: Number(fields[1]), start: fields[19], rss_kb: Number(fields[21]) * 4 });
    } catch {}
  }
  return result;
}

export function ownedProcessInventory({ clientProcess, brokerSession, brokerInventory, processes }) {
  if (brokerSession && brokerInventory) {
    if (brokerInventory.session_id !== brokerSession.session_id) {
      return { status: 'BLOCKED', reason: 'BROKER_SESSION_OWNERSHIP_MISMATCH', identities: [] };
    }
    if (brokerInventory.status !== 'OBSERVED' || !Array.isArray(brokerInventory.identities) || !brokerInventory.identities.length) {
      return { status: 'BLOCKED', reason: brokerInventory.reason || 'BROKER_PROCESS_INVENTORY_UNAVAILABLE', identities: [] };
    }
    return {
      status: 'OBSERVED',
      source: brokerInventory.source || 'broker-owned-process-group',
      identities: brokerInventory.identities,
    };
  }
  const pid = clientProcess?.pid;
  if (!Number.isInteger(pid)) {
    return { status: 'BLOCKED', reason: brokerSession ? 'BROKER_PROCESS_INVENTORY_UNAVAILABLE' : 'MCP_PROCESS_INVENTORY_UNAVAILABLE', identities: [] };
  }
  if (!processes.has(pid)) return { status: 'BLOCKED', reason: 'MCP_PROCESS_NOT_PRESENT', identities: [] };
  const pids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes.values()) if (pids.has(process.parent) && !pids.has(process.pid)) { pids.add(process.pid); changed = true; }
  }
  const identities = [...pids].map(id => processes.get(id)).filter(Boolean);
  return identities.length
    ? { status: 'OBSERVED', source: 'mcp-stdio-pid-and-descendants', identities }
    : { status: 'BLOCKED', reason: 'MCP_PROCESS_INVENTORY_EMPTY', identities: [] };
}
