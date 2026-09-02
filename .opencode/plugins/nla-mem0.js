import { tool } from '@opencode-ai/plugin';
import { Mem0HttpClient, mem0Config, resolveMem0UserID } from './nla-mem0-client.mjs';

export const NlaMem0Plugin = async () => {
  const config = mem0Config();
  const client = new Mem0HttpClient(config);

  const memoryAdd = tool({
    description: 'Add one durable fact or preference to the separately configured Mem0 service. Never store credentials, private keys, or transient transcript text.',
    args: {
      text: tool.schema.string().max(32000).describe('Self-contained durable fact or preference'),
      user_id: tool.schema.string().max(200).optional().describe('Stable memory namespace; defaults to NLA_MEM0_USER_ID'),
      infer: tool.schema.boolean().optional().describe('Use Mem0 LLM extraction; defaults to true'),
    },
    execute: async (args) => {
      const userID = resolveMem0UserID(args.user_id, config.userID);
      const result = await client.add({ text: args.text, userID, infer: args.infer ?? true });
      return { title: 'Mem0 memory added', output: JSON.stringify(result), metadata: { user_id: userID } };
    },
  });

  const memorySearch = tool({
    description: 'Search durable memories in the separately configured Mem0 service using a stable user namespace.',
    args: {
      query: tool.schema.string().max(8000).describe('Semantic memory query'),
      user_id: tool.schema.string().max(200).optional().describe('Stable memory namespace; defaults to NLA_MEM0_USER_ID'),
      limit: tool.schema.number().int().min(1).max(20).optional().describe('Maximum results; defaults to 5'),
    },
    execute: async (args) => {
      const userID = resolveMem0UserID(args.user_id, config.userID);
      const result = await client.search({ query: args.query, userID, limit: args.limit ?? 5 });
      return { title: 'Mem0 memory search', output: JSON.stringify(result), metadata: { user_id: userID } };
    },
  });

  return { tool: { memory_add: memoryAdd, memory_search: memorySearch } };
};
