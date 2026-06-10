import express from 'express';
import cors from 'cors';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { InboundMessage } from '../router';
import { logger } from '../logger';
import { ContainerRunner } from '../container/runner';

const WEB_HOST = process.env.WEB_HOST || '127.0.0.1';
const WEB_PORT = parseInt(process.env.WEB_PORT || '3080');
const ONECLI_PORT = parseInt(process.env.ONECLI_PORT || '4891');

// In-memory store for SSE clients keyed by recipientId (webui-user)
const sseClients = new Map<string, express.Response[]>();

export function startWebUI(router: (msg: InboundMessage) => Promise<void>): void {
  const app = express();
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '../../public')));

  app.post('/api/message', async (req, res) => {
    const { content, type = 'text', groupId = 'main' } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });

    const msg: InboundMessage = {
      id: uuidv4(),
      groupId,
      senderId: 'webui-user',
      channel: 'webui',
      type,
      content,
      timestamp: Date.now(),
    };

    try {
      await router(msg);
      res.json({ ok: true, id: msg.id });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: 'routing failed' });
    }
  });

  // SSE stream so the web UI can receive outbound messages in real time
  app.get('/api/stream', (req, res) => {
    const recipientId = (req.query.recipientId as string) || 'webui-user';
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clients = sseClients.get(recipientId) || [];
    clients.push(res);
    sseClients.set(recipientId, clients);

    req.on('close', () => {
      const remaining = (sseClients.get(recipientId) || []).filter(c => c !== res);
      sseClients.set(recipientId, remaining);
    });
  });

  app.listen(WEB_PORT, WEB_HOST, () => {
    logger.info(`Web UI listening on http://${WEB_HOST}:${WEB_PORT}`);
  });
}

export function registerHealthRoute(
  app: express.Express,
  containerRunner: ContainerRunner,
  schedulerTaskCount: () => number,
): void {
  app.get('/health', async (req, res) => {
    const containers = containerRunner.getRunningContainers();
    const groupsHealth: Record<string, { container_running: boolean }> = {};
    for (const [groupId] of containers) {
      groupsHealth[groupId] = { container_running: true };
    }

    let onecliReachable = false;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 1000);
      const resp = await fetch(`http://127.0.0.1:${ONECLI_PORT}`, { method: 'HEAD', signal: ctrl.signal });
      clearTimeout(timeout);
      onecliReachable = resp.status > 0;
    } catch { /* not reachable */ }

    res.json({
      status: 'ok',
      uptime_seconds: Math.floor(process.uptime()),
      groups: groupsHealth,
      onecli_reachable: onecliReachable,
      scheduler_task_count: schedulerTaskCount(),
    });
  });
}

export async function sendWebUI(recipientId: string, content: string): Promise<void> {
  const clients = sseClients.get(recipientId) || [];
  const payload = JSON.stringify({ content, timestamp: Date.now() });
  for (const client of clients) {
    client.write(`data: ${payload}\n\n`);
  }
  logger.debug({ recipientId, clientCount: clients.length }, 'Web UI message pushed');
}
