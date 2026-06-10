import { makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { InboundMessage } from '../router';
import { logger } from '../logger';

const AUTH_DIR = path.join(process.env.HOME || '/root', 'nanoclaw', 'data', 'whatsapp-auth');

let waSocket: ReturnType<typeof makeWASocket> | null = null;

export async function startWhatsApp(router: (msg: InboundMessage) => Promise<void>): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  waSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Settings → Linked Devices → Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
      logger.info({ shouldReconnect }, 'WhatsApp disconnected');
      if (shouldReconnect) startWhatsApp(router);
    } else if (connection === 'open') {
      logger.info('WhatsApp connected');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (m.key.fromMe) continue;
      const remoteJid = m.key.remoteJid || '';
      const senderId = m.key.participant || remoteJid;
      const groupId = remoteJid.endsWith('@g.us')
        ? `whatsapp_${remoteJid.split('@')[0]}`
        : 'main';

      let content = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      let type: InboundMessage['type'] = 'text';
      let mimeType: string | undefined;

      if (m.message?.audioMessage) {
        type = 'voice';
        mimeType = 'audio/ogg';
        content = '[voice note — transcription pending]';
      } else if (m.message?.imageMessage) {
        type = 'image';
        mimeType = 'image/jpeg';
        content = '[image]';
      }

      if (!content) continue;

      await router({
        id: m.key.id || uuidv4(),
        groupId,
        senderId,
        channel: 'whatsapp',
        type,
        content,
        mimeType,
        timestamp: (m.messageTimestamp as number) * 1000,
      });
    }
  });
}

export async function sendWhatsApp(recipientId: string, content: string): Promise<void> {
  if (!waSocket) {
    logger.error({ recipientId }, 'WhatsApp socket not initialised — cannot send');
    throw new Error('WhatsApp not connected');
  }
  await waSocket.sendMessage(recipientId, { text: content });
  logger.debug({ recipientId }, 'WhatsApp message sent');
}
