import { tool } from '@opencode-ai/plugin';
import { Mem0HttpClient, mem0Config, resolveMem0UserID } from './nla-mem0-client.mjs';

export const NlaMem0Plugin = async () => {
  const config = mem0Config();
  const client = new Mem0HttpClient(config);

  const memoryAdd = tool({
    description: 'Add one durable fact or preference to the separately configured Mem0 service. Never store credentials, private keys, or transient transcript text.',
    args: {
      text: tool.schema.string().max(32000).describe('Self-contained durable fact or preference'),
      infer: tool.schema.boolean().optional().describe('Use Mem0 LLM extraction; defaults to true'),
    },
    execute: async (args) => {
      const userID = resolveMem0UserID(undefined, config.userID);
      const result = await client.add({ text: args.text, userID, infer: args.infer ?? true });
      return { title: 'Mem0 memory added', output: JSON.stringify(result), metadata: { user_id: userID } };
    },
  });

  const memorySearch = tool({
    description: 'Search durable memories in the separately configured Mem0 service using a stable user namespace.',
    args: {
      query: tool.schema.string().max(8000).describe('Semantic memory query'),
      limit: tool.schema.number().int().min(1).max(20).optional().describe('Maximum results; defaults to 5'),
    },
    execute: async (args) => {
      const userID = resolveMem0UserID(undefined, config.userID);
      const result = await client.search({ query: args.query, userID, limit: args.limit ?? 5 });
      return { title: 'Mem0 memory search', output: JSON.stringify(result), metadata: { user_id: userID } };
    },
  });

  const scopedUser = () => resolveMem0UserID(undefined, config.userID);
  const memoryList = tool({
    description: 'List durable memories for one stable Mem0 user namespace.',
    args: {
      limit: tool.schema.number().int().min(1).max(100).optional().describe('Maximum results; defaults to 20'),
    },
    execute: async (args) => {
      const userID = scopedUser(args);
      const result = await client.list({ userID, limit: args.limit ?? 20 });
      return { title: 'Mem0 memory list', output: JSON.stringify(result), metadata: { user_id: userID } };
    },
  });
  const memoryGet = tool({
    description: 'Get one durable memory by ID within a stable Mem0 user namespace.',
    args: {
      memory_id: tool.schema.string().max(200).describe('Mem0 memory ID'),
    },
    execute: async (args) => {
      const userID = scopedUser(args);
      const result = await client.get({ memoryID: args.memory_id, userID });
      return { title: 'Mem0 memory retrieved', output: JSON.stringify(result), metadata: { user_id: userID, memory_id: args.memory_id } };
    },
  });
  const memoryUpdate = tool({
    description: 'Replace the text of one durable memory within its stable Mem0 user namespace.',
    args: {
      memory_id: tool.schema.string().max(200).describe('Mem0 memory ID'),
      text: tool.schema.string().max(32000).describe('Complete replacement memory text'),
    },
    execute: async (args) => {
      const userID = scopedUser(args);
      const result = await client.update({ memoryID: args.memory_id, text: args.text, userID });
      return { title: 'Mem0 memory updated', output: JSON.stringify(result), metadata: { user_id: userID, memory_id: args.memory_id } };
    },
  });
  const memoryDelete = tool({
    description: 'Delete one durable memory by ID within its stable Mem0 user namespace.',
    args: {
      memory_id: tool.schema.string().max(200).describe('Mem0 memory ID'),
    },
    execute: async (args) => {
      const userID = scopedUser(args);
      const result = await client.delete({ memoryID: args.memory_id, userID });
      return { title: 'Mem0 memory deleted', output: JSON.stringify(result), metadata: { user_id: userID, memory_id: args.memory_id } };
    },
  });
  const memoryHistory = tool({
    description: 'Get Mem0 ADD and UPDATE history for one existing scoped memory.',
    args: {
      memory_id: tool.schema.string().max(200).describe('Mem0 memory ID'),
    },
    execute: async (args) => {
      const userID = scopedUser(args);
      const result = await client.history({ memoryID: args.memory_id, userID });
      return { title: 'Mem0 memory history', output: JSON.stringify(result), metadata: { user_id: userID, memory_id: args.memory_id } };
    },
  });

  return { tool: {
    memory_add: memoryAdd,
    memory_search: memorySearch,
    memory_list: memoryList,
    memory_get: memoryGet,
    memory_update: memoryUpdate,
    memory_delete: memoryDelete,
    memory_history: memoryHistory,
  } };
};
