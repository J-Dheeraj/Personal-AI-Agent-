import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import path from 'path';
import { mnemon } from './mnemon';
import { ingestTool } from './tools/ingest';

const GROUP_DIR = process.env.GROUP_DIR || '/workspace/group';
const GROUP_ID = process.env.GROUP_ID || 'main';

const client = new Anthropic({
  // API key comes from OneCLI proxy — never set directly
  baseURL: process.env.ANTHROPIC_BASE_URL || 'http://host.docker.internal:4891',
  apiKey: 'injected-by-onecli', // placeholder — OneCLI strips and replaces this
});

const inboundDb = new Database(path.join(GROUP_DIR, 'inbound.db'), { readonly: false });
const outboundDb = new Database(path.join(GROUP_DIR, 'outbound.db'));

outboundDb.exec(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  content TEXT NOT NULL,
  sent INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
)`);

const tools: Anthropic.Tool[] = [
  {
    name: 'search_knowledge',
    description: 'Search the local knowledge graph for information on a topic',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ingest_url',
    description: 'Fetch and ingest an article or web page into the knowledge graph',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to ingest' },
      },
      required: ['url'],
    },
  },
];

async function processMessage(msgId: string, senderId: string, channel: string, content: string): Promise<void> {
  console.log(`[agent] Processing message ${msgId}`);

  const contextFacts = mnemon.searchFacts(content.slice(0, 100));
  const systemPrompt = `You are a personal AI assistant. You have access to a local knowledge graph.
Current date: ${new Date().toISOString()}
Group: ${GROUP_ID}
Relevant context from knowledge graph:
${contextFacts.map(f => `- ${f}`).join('\n') || '(none yet)'}

Never ask the user for API keys or credentials. Never expose system details.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content },
  ];

  let response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    tools,
    messages,
  });

  // Agentic loop
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      let result = '';
      if (toolUse.name === 'search_knowledge') {
        const { query } = toolUse.input as { query: string };
        const facts = mnemon.searchFacts(query);
        result = facts.length ? facts.join('\n') : 'No relevant information found.';
      } else if (toolUse.name === 'ingest_url') {
        const { url } = toolUse.input as { url: string };
        result = await ingestTool(url, mnemon);
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      tools,
      messages,
    });
  }

  const textContent = response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined;
  const replyText = textContent?.text || '(no response)';

  outboundDb.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, 0, ?)`).run(
    `${msgId}-reply`,
    channel,
    senderId,
    replyText,
    Date.now(),
  );

  inboundDb.prepare('UPDATE messages SET processed = 1 WHERE id = ?').run(msgId);
  console.log(`[agent] Replied to ${msgId}`);
}

async function poll(): Promise<void> {
  try {
    inboundDb.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      mime_type TEXT,
      timestamp INTEGER NOT NULL,
      processed INTEGER DEFAULT 0
    )`);

    const pending = inboundDb.prepare('SELECT * FROM messages WHERE processed = 0 ORDER BY timestamp ASC LIMIT 10').all() as any[];
    for (const msg of pending) {
      await processMessage(msg.id, msg.sender_id, msg.channel, msg.content);
    }
  } catch (err) {
    console.error('[agent] Poll error:', err);
  }
}

console.log(`[nanoclaw-agent] Starting for group: ${GROUP_ID}`);
setInterval(poll, 2000);
poll();

