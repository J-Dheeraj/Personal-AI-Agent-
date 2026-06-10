import TelegramBot from 'node-telegram-bot-api';
import { v4 as uuidv4 } from 'uuid';
import { InboundMessage } from '../router';
import { logger } from '../logger';

let telegramBot: TelegramBot | null = null;

export function startTelegram(token: string, router: (msg: InboundMessage) => Promise<void>): void {
  const bot = new TelegramBot(token, { polling: true });
  telegramBot = bot;
  logger.info('Telegram bot started');

  bot.on('message', async (msg) => {
    const senderId = `${msg.from?.id}@telegram`;
    const groupId = msg.chat.type === 'private'
      ? 'main'
      : `telegram_${Math.abs(msg.chat.id)}`;

    let type: InboundMessage['type'] = 'text';
    let content = msg.text || '';

    if (msg.voice) {
      type = 'voice';
      content = '[voice note — transcription pending]';
    } else if (msg.photo) {
      type = 'image';
      content = '[image]';
    } else if (msg.document) {
      type = 'document';
      content = `[document: ${msg.document.file_name}]`;
    }

    if (!content) return;

    await router({
      id: uuidv4(),
      groupId,
      senderId,
      channel: 'telegram',
      type,
      content,
      timestamp: msg.date * 1000,
    });
  });
}

export async function sendTelegram(recipientId: string, content: string): Promise<void> {
  if (!telegramBot) {
    logger.error({ recipientId }, 'Telegram bot not initialised — cannot send');
    throw new Error('Telegram not connected');
  }
  // recipientId is stored as "<chatId>@telegram" or plain chatId
  const chatId = recipientId.replace('@telegram', '');
  await telegramBot.sendMessage(chatId, content);
  logger.debug({ recipientId }, 'Telegram message sent');
}
