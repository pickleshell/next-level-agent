import fs from 'node:fs';

const toolURL = process.env.NLA_TOOL_CATALOG_URL || 'http://127.0.0.1:41987/experimental/tool';
const ollamaURL = process.env.NLA_OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
const model = process.env.NLA_OLLAMA_MODEL || 'qwen3:4b';
const timeoutMs = Number(process.env.NLA_BENCHMARK_TIMEOUT_MS || 30000);
const outputPath = process.argv[2];
const prompt = 'Bounded implementer task: inspect README.md, change no files, and report its first Markdown heading. Acceptance criteria: return the exact heading and state that no files were changed. Preserve this user-provided provenance.';
const shortlistIDs = ['read', 'edit', 'write', 'bash'];

const query = new URL(toolURL);
query.searchParams.set('directory', process.cwd());
query.searchParams.set('provider', 'ollama');
query.searchParams.set('model', model);
const catalogResponse = await fetch(query);
if (!catalogResponse.ok) throw new Error(`OpenCode tool catalog HTTP ${catalogResponse.status}`);
const resolvedCatalog = await catalogResponse.json();
// OpenCode's endpoint includes an internal error-reporting sentinel which is
// not a normal callable child-agent capability.
const catalog = resolvedCatalog.filter((item) => item.id !== 'invalid');
const convert = (items) => items.map((item) => ({
  type: 'function', function: { name: item.id, description: item.description, parameters: item.parameters },
}));
const variants = {
  full: convert(catalog),
  shortlist: convert(catalog.filter((item) => shortlistIDs.includes(item.id))),
};
if (variants.shortlist.length !== shortlistIDs.length) throw new Error('Resolved OpenCode catalog is missing a shortlist tool');

async function invoke(label, tools, run) {
  const started = performance.now();
  try {
    const response = await fetch(ollamaURL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model, stream: false, think: false, keep_alive: '10m', messages: [{ role: 'user', content: prompt }], tools,
        options: { temperature: 0, seed: 42, num_predict: 64 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = await response.json();
    return {
      label, run, tool_count: tools.length, schema_bytes: Buffer.byteLength(JSON.stringify(tools)),
      wall_ms: Math.round(performance.now() - started), prompt_eval_count: body.prompt_eval_count,
      prompt_eval_ms: Math.round((body.prompt_eval_duration || 0) / 1e6), eval_count: body.eval_count,
      eval_ms: Math.round((body.eval_duration || 0) / 1e6), timed_out: false,
      response_kind: body.message?.tool_calls?.length ? 'tool_call' : 'text',
    };
  } catch (error) {
    return {
      label, run, tool_count: tools.length, schema_bytes: Buffer.byteLength(JSON.stringify(tools)),
      wall_ms: Math.round(performance.now() - started), timed_out: error?.name === 'TimeoutError',
      error: String(error?.message || error),
    };
  }
}

// Warm model loading outside the measured runs.
await fetch(ollamaURL, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, stream: false, think: false, keep_alive: '10m', messages: [{ role: 'user', content: 'Reply OK' }], options: { num_predict: 2 } }),
});

const runs = [];
for (let run = 1; run <= 3; run += 1) {
  for (const label of run % 2 ? ['full', 'shortlist'] : ['shortlist', 'full']) runs.push(await invoke(label, variants[label], run));
}
const result = {
  timestamp: new Date().toISOString(), model, prompt, timeout_ms: timeoutMs,
  excluded_internal_ids: resolvedCatalog.filter((item) => item.id === 'invalid').map((item) => item.id),
  catalog_ids: catalog.map((item) => item.id), shortlist_ids: shortlistIDs, runs,
};
for (const label of ['full', 'shortlist']) {
  const rows = runs.filter((row) => row.label === label);
  const average = (key) => Math.round(rows.reduce((sum, row) => sum + (row[key] || 0), 0) / rows.length);
  result[label] = {
    tool_count: rows[0].tool_count, schema_bytes: rows[0].schema_bytes,
    prompt_eval_count: [...new Set(rows.map((row) => row.prompt_eval_count))],
    avg_wall_ms: average('wall_ms'),
    avg_prompt_eval_ms: rows.some((row) => Number.isFinite(row.prompt_eval_ms)) ? average('prompt_eval_ms') : null,
    failures: rows.filter((row) => row.error).length, timeouts: rows.filter((row) => row.timed_out).length,
  };
}
const rendered = JSON.stringify(result, null, 2) + '\n';
if (outputPath) fs.writeFileSync(outputPath, rendered);
process.stdout.write(rendered);
