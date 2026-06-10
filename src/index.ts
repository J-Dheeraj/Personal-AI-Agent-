import path from 'path';
import fs from 'fs';
import { router } from './router';
import { startWebUI, registerHealthRoute } from './channels/webui';
import { startCLI } from './channels/cli';
import { startDelivery, flushAndClose } from './delivery';
import { startScheduler, loadPersistedTasks, getTaskCount } from './scheduler';
import { initAllowlist, closeAllowlistWatcher } from './security/senderAllowlist';
import { ContainerRunner } from './container/runner';
import { logger } from './logger';

const DATA_DIR = path.join(process.env.HOME || '/root', 'nanoclaw', 'data');
const GROUPS_DIR = path.join(process.env.HOME || '/root', 'nanoclaw', 'groups');

[DATA_DIR, GROUPS_DIR, path.join(DATA_DIR, 'ipc')].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

export let shuttingDown = false;
let shutdownInProgress = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    logger.warn('Forced exit on second signal');
    process.exit(1);
  }
  shutdownInProgress = true;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully...');

  closeAllowlistWatcher();

  await flushAndClose();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function main(): Promise<void> {
  logger.info('NanoClaw v2 starting...');

  // Security: load allowlist before accepting any messages (fail-closed)
  initAllowlist();

  startDelivery();
  startScheduler();
  loadPersistedTasks();

  const containerRunner = new ContainerRunner();

  // Build express app so health route and web UI share the same instance
  const express = await import('express');
  const app = express.default();
  registerHealthRoute(app, containerRunner, getTaskCount);

  startWebUI(router);
  startCLI(router);

  // WhatsApp and Telegram start lazily via /add-whatsapp and /add-telegram commands
  logger.info('NanoClaw v2 ready. Web UI: http://localhost:3080  Health: http://localhost:3080/health');
}

main().catch(err => {
  logger.error(err, 'Fatal startup error');
  process.exit(1);
});
