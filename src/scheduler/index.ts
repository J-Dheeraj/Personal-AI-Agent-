import cron from 'node-cron';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger';

const DATA_DIR = path.join(process.env.HOME || '/root', 'nanoclaw', 'data');
const GROUPS_DIR = path.join(process.env.HOME || '/root', 'nanoclaw', 'groups');

interface ScheduledTask {
  id: string;
  cronExpr: string;
  groupId: string;
  prompt: string;
}

const activeCronJobs = new Map<string, cron.ScheduledTask>();
let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(path.join(DATA_DIR, 'scheduler.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      cron TEXT NOT NULL,
      group_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    )`);
  }
  return db;
}

function injectPromptIntoGroup(groupId: string, prompt: string): void {
  const groupDir = path.join(GROUPS_DIR, groupId);
  if (!fs.existsSync(groupDir)) {
    logger.warn({ groupId }, 'Scheduled task fired but group directory does not exist');
    return;
  }
  const inboundDb = new Database(path.join(groupDir, 'inbound.db'));
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
  inboundDb.prepare(`INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(uuidv4(), 'scheduler', 'cli', 'text', prompt, null, Date.now());
  inboundDb.close();
}

export function startScheduler(): void {
  logger.info('Task scheduler started');
}

export function registerTask(task: ScheduledTask): void {
  if (activeCronJobs.has(task.id)) {
    activeCronJobs.get(task.id)!.stop();
  }

  const database = getDb();
  database.prepare(`INSERT OR REPLACE INTO tasks (id, cron, group_id, prompt, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
    .run(task.id, task.cronExpr, task.groupId, task.prompt, Date.now());

  const job = cron.schedule(task.cronExpr, () => {
    logger.info({ taskId: task.id, groupId: task.groupId }, 'Scheduled task triggered');
    injectPromptIntoGroup(task.groupId, task.prompt);
  });

  activeCronJobs.set(task.id, job);
  logger.info({ taskId: task.id, cron: task.cronExpr }, 'Task registered');
}

export function removeTask(id: string): void {
  activeCronJobs.get(id)?.stop();
  activeCronJobs.delete(id);
  getDb().prepare(`UPDATE tasks SET enabled = 0 WHERE id = ?`).run(id);
  logger.info({ taskId: id }, 'Task removed');
}

export function listTasks(): ScheduledTask[] {
  return getDb()
    .prepare(`SELECT id, cron as cronExpr, group_id as groupId, prompt FROM tasks WHERE enabled = 1`)
    .all() as ScheduledTask[];
}

export function getTaskCount(): number {
  return activeCronJobs.size;
}

export function loadPersistedTasks(): void {
  const rows = listTasks();
  for (const task of rows) {
    const job = cron.schedule(task.cronExpr, () => {
      logger.info({ taskId: task.id, groupId: task.groupId }, 'Persisted task triggered');
      injectPromptIntoGroup(task.groupId, task.prompt);
    });
    activeCronJobs.set(task.id, job);
  }
  logger.info({ count: rows.length }, 'Persisted tasks loaded');
}
