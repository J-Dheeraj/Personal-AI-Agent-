import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from '../logger';
import { sendWhatsApp } from '../channels/whatsapp';
import { sendTelegram } from '../channels/telegram';
import { sendWebUI } from '../channels/webui';

const GROUPS_DIR = path.join(process.env.HOME || '/root', 'nanoclaw', 'groups');

interface OutboundMessage {
  id: string;
  channel: string;
  recipient_id: string;
  content: string;
  sent: number;
  timestamp: number;
}

// Open db handles are kept alive across polls to avoid open/close overhead
const openDbs = new Map<string, Database.Database>();
let deliveryActive = false;

export function startDelivery(): void {
  setInterval(() => {
    if (!deliveryActive) pollAllGroups();
  }, 1000);
  logger.info('Delivery poller started');
}

export async function flushAndClose(): Promise<void> {
  // Wait for any in-flight poll to complete (up to 5 s)
  const deadline = Date.now() + 5000;
  while (deliveryActive && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
  for (const [, db] of openDbs) {
    try { db.close(); } catch { /* ignore */ }
  }
  openDbs.clear();
}

function pollAllGroups(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;
  deliveryActive = true;
  try {
    const groups = fs.readdirSync(GROUPS_DIR);
    for (const group of groups) {
      const outboundPath = path.join(GROUPS_DIR, group, 'outbound.db');
      if (!fs.existsSync(outboundPath)) continue;
      try {
        deliverPending(group, outboundPath);
      } catch (err) {
        logger.error({ err, group }, 'Delivery poll error');
      }
    }
  } finally {
    deliveryActive = false;
  }
}

function getDb(dbPath: string): Database.Database {
  if (!openDbs.has(dbPath)) {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      content TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    )`);
    openDbs.set(dbPath, db);
  }
  return openDbs.get(dbPath)!;
}

function deliverPending(groupId: string, dbPath: string): void {
  const db = getDb(dbPath);
  const pending = db.prepare('SELECT * FROM messages WHERE sent = 0 ORDER BY timestamp ASC').all() as OutboundMessage[];

  for (const msg of pending) {
    dispatchMessage(msg)
      .then(() => {
        db.prepare('UPDATE messages SET sent = 1 WHERE id = ?').run(msg.id);
        logger.info({ groupId, channel: msg.channel, recipient: msg.recipient_id }, 'Message delivered');
      })
      .catch((err) => {
        logger.error({ err, msgId: msg.id, channel: msg.channel }, 'Delivery failed — will retry next poll');
      });
  }
}

async function dispatchMessage(msg: OutboundMessage): Promise<void> {
  switch (msg.channel) {
    case 'whatsapp':
      await sendWhatsApp(msg.recipient_id, msg.content);
      break;
    case 'telegram':
      await sendTelegram(msg.recipient_id, msg.content);
      break;
    case 'webui':
      await sendWebUI(msg.recipient_id, msg.content);
      break;
    case 'cli':
      process.stdout.write(`\n[agent] ${msg.content}\n`);
      break;
    default:
      logger.warn({ channel: msg.channel, msgId: msg.id }, 'Unknown channel — cannot deliver');
  }
}
