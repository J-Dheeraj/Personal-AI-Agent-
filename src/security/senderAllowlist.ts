import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

interface GroupAllowlist {
  mode: 'drop' | 'trigger';
  allowedSenders: string[];
}

interface AllowlistConfig {
  defaultMode: 'drop' | 'trigger';
  groups: Record<string, GroupAllowlist>;
}

const CONFIG_PATH = path.join(process.env.HOME || '/root', '.config', 'nanoclaw', 'sender-allowlist.json');

let cachedConfig: AllowlistConfig | null = null;
let configWatcher: fs.FSWatcher | null = null;

function loadConfig(): AllowlistConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    throw new Error(`sender-allowlist.json could not be read at ${CONFIG_PATH}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`sender-allowlist.json is not valid JSON: ${(err as Error).message}`);
  }

  const config = parsed as AllowlistConfig;
  if (config.defaultMode !== 'drop' && config.defaultMode !== 'trigger') {
    throw new Error(`sender-allowlist.json: defaultMode must be 'drop' or 'trigger', got '${config.defaultMode}'`);
  }
  if (!config.groups || typeof config.groups !== 'object') {
    throw new Error(`sender-allowlist.json: 'groups' must be an object`);
  }

  return config;
}

export function initAllowlist(): void {
  try {
    cachedConfig = loadConfig();
    logger.info('Sender allowlist loaded');
  } catch (err) {
    logger.error({ err }, 'FATAL: sender-allowlist.json failed to load — all messages will be rejected');
    cachedConfig = null;
  }

  try {
    configWatcher = fs.watch(CONFIG_PATH, () => {
      try {
        cachedConfig = loadConfig();
        logger.info('Sender allowlist reloaded');
      } catch (err) {
        logger.error({ err }, 'Sender allowlist reload failed — retaining previous config');
      }
    });
  } catch {
    // File may not exist yet; watcher will not fire — that is acceptable
  }
}

export function closeAllowlistWatcher(): void {
  configWatcher?.close();
  configWatcher = null;
}

export function checkSenderAllowed(groupId: string, senderId: string): boolean {
  if (!cachedConfig) {
    logger.error({ groupId, senderId }, 'Sender allowlist not loaded — rejecting message (fail-closed)');
    return false;
  }

  const groupConfig = cachedConfig.groups[groupId];
  const mode = groupConfig?.mode ?? cachedConfig.defaultMode;
  const allowedSenders = groupConfig?.allowedSenders ?? [];

  if (allowedSenders.includes(senderId)) return true;

  logger.info({ senderId, groupId, mode }, 'Sender not in allowlist');
  return false;
}

export function reloadConfig(): void {
  try {
    cachedConfig = loadConfig();
    logger.info('Sender allowlist force-reloaded');
  } catch (err) {
    logger.error({ err }, 'FATAL: sender-allowlist.json reload failed — all messages will be rejected');
    cachedConfig = null;
  }
}
