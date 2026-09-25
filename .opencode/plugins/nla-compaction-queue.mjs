// summarize creates a compaction part, then waits for the session loop. Awaiting
// that entire HTTP request from a tool hook would deadlock the same loop.
// Acknowledge the durable queue entry instead; native OpenCode processes it
// after the current tool batch, and auto:true continues without user input.
export async function enqueueNativeCompaction({ client, sessionID, directory, model, onError, timeoutMs = 5000 }) {
  const read = async () => {
    const result = await client.session.messages({ path: { id: sessionID }, query: { directory, limit: 10 }, throwOnError: true, signal: AbortSignal.timeout(timeoutMs) });
    if (result?.error) throw new Error('Cannot inspect native compaction queue');
    if (!Array.isArray(result?.data)) throw new Error('Native message inventory unavailable');
    return result.data.flatMap(message => (message.parts || []).filter(part => part.type === 'compaction').map(part => part.id));
  };
  const before = new Set(await read());
  let failure;
  void Promise.resolve().then(() => client.session.summarize({
    path: { id: sessionID }, query: { directory }, body: { ...model, auto: true }, throwOnError: true,
  })).then(result => {
    if (result?.error) throw new Error('Native compaction request failed');
  }).catch(error => { failure = error; onError(error); });
  const deadline = Date.now() + timeoutMs;
  do {
    if (failure) throw failure;
    if ((await read()).some(id => id && !before.has(id))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  // Do not submit a second request after an uncertain acknowledgement.
  throw new Error('Native compaction queue acknowledgement timed out');
}
