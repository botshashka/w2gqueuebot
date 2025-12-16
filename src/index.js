require('dotenv').config();
const { Telegraf } = require('telegraf');
const { getRoom, setRoom } = require('./db');
const { createRoom, addToPlaylist } = require('./w2g');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || !process.env.W2G_API_KEY) {
  console.error('Missing required env vars: TELEGRAM_BOT_TOKEN, W2G_API_KEY');
  process.exit(1);
}

const bot = new Telegraf(token, { handlerTimeout: 30_000 });

const PROMPT_GRACE_PERIOD_MS = 60_000;
const PREVIOUS_MESSAGE_WINDOW_MS = 30_000;
const promptWindows = new Map(); // chatId -> timestamp
const lastUserMessages = new Map(); // chatId -> lightweight last message snapshot
const usedMessagesByChat = new Map(); // chatId -> { set: Set<number>, queue: number[] }

function getText(message) {
  return message?.text || message?.caption || '';
}

function extractFromEntities(message) {
  if (!message) return null;
  const text = getText(message);
  const entities = message.entities || message.caption_entities || [];

  for (const entity of entities) {
    if (entity.type === 'url') {
      const urlText = text.substring(entity.offset, entity.offset + entity.length);
      if (urlText) return urlText;
    }
    if (entity.type === 'text_link' && entity.url) {
      return entity.url;
    }
  }

  return null;
}

function validateCandidate(url) {
  if (!url) return { url: null, invalid: false };
  let candidate = url;
  if (!candidate.match(/^https?:\/\//i)) {
    candidate = 'https://' + candidate;
  }

  try {
    const parsed = new URL(candidate);
    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol.toLowerCase())) {
      return { url: null, invalid: false };
    }
    return { url: parsed.toString(), invalid: false };
  } catch {
    return { url: null, invalid: true };
  }
}

function findUrl(ctx, previousMessage) {
  const msg = ctx.message;
  const reply = msg?.reply_to_message;
  const canUseReply = reply && !reply.from?.is_bot;

  const candidates = [
    { raw: extractFromEntities(msg), sourceId: msg?.message_id },
    { raw: canUseReply ? extractFromEntities(reply) : null, sourceId: canUseReply ? reply.message_id : null },
    // Removed raw text scanning
  ];

  if (previousMessage) {
    // If previousMessage has a stored URL, use it directly.
    // The structure of previousMessage is now { url: string|null, ... }
    if (previousMessage.url) {
      candidates.push({ raw: previousMessage.url, sourceId: previousMessage.message_id });
    }
  }

  for (const raw of candidates) {
    const candidate = raw?.raw;
    if (!candidate) continue;
    const result = validateCandidate(candidate);
    if (result.url) return { ...result, sourceMessageId: raw.sourceId || null };
    if (result.invalid) return { ...result, sourceMessageId: raw.sourceId || null };
  }

  return { url: null, invalid: false, sourceMessageId: null };
}

function messageMentionsBot(ctx) {
  const message = ctx.message;
  if (!message) return false;

  const rawUsername = ctx.botInfo?.username || bot.botInfo?.username || '';
  const username = rawUsername.replace('@', '').toLowerCase();
  const mentionTag = `@${username}`;

  const text = getText(message);
  const entities = message.entities || message.caption_entities || [];

  for (const entity of entities) {
    if (entity.type === 'mention') {
      const mention = text.substring(entity.offset, entity.offset + entity.length);
      if (mention.toLowerCase() === mentionTag) return true;
    }
  }

  return text.toLowerCase().includes(mentionTag);
}

async function ensureRoom(chatId, initialUrl) {
  const existing = getRoom(chatId);
  if (existing?.streamkey) {
    return existing.streamkey;
  }

  const streamkey = await createRoom(initialUrl);
  setRoom(chatId, streamkey);
  return streamkey;
}

function buildRoomLink(streamkey) {
  return `https://w2g.tv/rooms/${streamkey}`;
}

function markPrompt(chatId) {
  promptWindows.set(chatId, Date.now());
}

function isWithinPromptWindow(chatId) {
  const lastPrompt = promptWindows.get(chatId);
  if (!lastPrompt) return false;
  return Date.now() - lastPrompt <= PROMPT_GRACE_PERIOD_MS;
}

function consumePromptWindow(chatId) {
  const active = isWithinPromptWindow(chatId);
  if (active) {
    promptWindows.delete(chatId);
  }
  return active;
}

function snapshotUserMessage(message) {
  if (!message || !message.chat || !message.from || message.from.is_bot) return null;
  const timestampMs = (message.date ? message.date * 1000 : Date.now());
  // Privacy: Extract URL immediately and discard text.
  const urlCandidate = extractFromEntities(message);

  return {
    chatId: message.chat.id,
    fromId: message.from.id,
    date: timestampMs,
    message_id: message.message_id,
    url: urlCandidate, // Store only the URL (or null)
  };
}

function rememberLastUserMessage(message) {
  const snapshot = snapshotUserMessage(message);
  if (!snapshot) return;
  lastUserMessages.set(snapshot.chatId, snapshot);
}

function recentPreviousMessage(chatId, fromId) {
  const prev = lastUserMessages.get(chatId);
  if (!prev) return null;
  if (fromId && prev.fromId !== fromId) return null;
  if (isMessageUsed(chatId, prev.message_id)) return null;
  if (Date.now() - prev.date > PREVIOUS_MESSAGE_WINDOW_MS) return null;
  return prev;
}

function isReplyToBot(ctx) {
  const reply = ctx.message?.reply_to_message;
  const botId = ctx.botInfo?.id || bot.botInfo?.id;
  if (!reply || !botId) return false;
  return reply.from?.id === botId;
}

function shouldHandleMessage(ctx) {
  const chatType = ctx.chat?.type;
  if (chatType === 'private') return true;

  if (messageMentionsBot(ctx)) return true;
  if (isReplyToBot(ctx)) return true;
  if (consumePromptWindow(ctx.chat.id)) return true;

  return false;
}

function getUsedBucket(chatId) {
  if (!usedMessagesByChat.has(chatId)) {
    usedMessagesByChat.set(chatId, { set: new Set(), queue: [] });
  }
  return usedMessagesByChat.get(chatId);
}

function markMessagesUsed(chatId, ids = []) {
  const bucket = getUsedBucket(chatId);
  for (const id of ids) {
    if (!id) continue;
    if (!bucket.set.has(id)) {
      bucket.queue.push(id);
    }
    bucket.set.add(id);
  }

  // Keep at most 20 entries to avoid unbounded growth.
  while (bucket.queue.length > 20) {
    const old = bucket.queue.shift();
    bucket.set.delete(old);
  }
}

function isMessageUsed(chatId, messageId) {
  if (!messageId) return false;
  const bucket = usedMessagesByChat.get(chatId);
  if (!bucket) return false;
  return bucket.set.has(messageId);
}

bot.start(async (ctx) => {
  await ctx.reply('Send me a link and I will add it to your Watch2Gether room. Try /help for details.');
  markPrompt(ctx.chat.id);
});

bot.command('help', async (ctx) => {
  const helpText = [
    'Add links to your Watch2Gether room for this chat.',
    '',
    'Groups:',
    `- Reply with @${ctx.botInfo?.username || bot.botInfo?.username} to a message that has a URL`,
    `- Or write @${ctx.botInfo?.username || bot.botInfo?.username} <url>`,
    '',
    'DMs:',
    '- Send any message with a URL',
    '',
    'Commands:',
    '/room - show the room link',
    '/clear - reset with a new room',
  ].join('\n');

  await ctx.reply(helpText);
});

bot.command('room', async (ctx) => {
  try {
    const streamkey = await ensureRoom(ctx.chat.id);
    await ctx.reply(`Room: ${buildRoomLink(streamkey)}`);
  } catch (err) {
    console.error('Error handling /room', err);
    await ctx.reply('Couldn’t load the room (W2G error). Try again.');
  }
});

bot.command('clear', async (ctx) => {
  try {
    const streamkey = await createRoom();
    setRoom(ctx.chat.id, streamkey);
    await ctx.reply(`Queue cleared ✅\nRoom: ${buildRoomLink(streamkey)}`);
  } catch (err) {
    console.error('Error handling /clear', err);
    await ctx.reply('Couldn’t clear the queue (W2G error). Try again.');
  }
});

bot.on('message', async (ctx) => {
  // Ignore commands here, handled above.
  const entities = ctx.message.entities || ctx.message.caption_entities || [];
  if (entities.some((e) => e.type === 'bot_command')) {
    return;
  }

  if (!shouldHandleMessage(ctx)) {
    rememberLastUserMessage(ctx.message);
    return;
  }

  const priorMessage = messageMentionsBot(ctx)
    ? recentPreviousMessage(ctx.chat.id, ctx.from?.id)
    : null;

  const { url, invalid, sourceMessageId } = findUrl(ctx, priorMessage);
  const chatId = ctx.chat.id;
  const invalidFromCurrentMessage = invalid && sourceMessageId === ctx.message?.message_id;

  if (invalidFromCurrentMessage && !url) {
    await ctx.reply('That doesn’t look like a valid URL.');
    rememberLastUserMessage(ctx.message);
    return;
  }
  if (!url || invalid) {
    const explicitInteraction = messageMentionsBot(ctx) || isReplyToBot(ctx) || ctx.chat.type === 'private';
    if (!explicitInteraction) {
      rememberLastUserMessage(ctx.message);
      return;
    }
    await ctx.reply('Send me a link to add. Try /help');
    markPrompt(chatId);
    rememberLastUserMessage(ctx.message);
    return;
  }

  try {
    const streamkey = await ensureRoom(chatId);
    await addToPlaylist(streamkey, url);
    await ctx.reply(`Added ✅\nRoom: ${buildRoomLink(streamkey)}`);
    const idsToMark = [sourceMessageId, ctx.message?.message_id].filter(Boolean);
    markMessagesUsed(chatId, idsToMark);
  } catch (err) {
    console.error('Error adding URL', err);
    await ctx.reply('Couldn’t add that (W2G error). Try again.');
  } finally {
    if (priorMessage) {
      lastUserMessages.delete(ctx.chat.id); // prevent reusing the same prior message repeatedly
    }
    rememberLastUserMessage(ctx.message);
  }
});

bot.catch((err, ctx) => {
  console.error('Bot error', err, ctx.updateType);
});

bot.launch().then(() => {
  console.log('Bot started with long polling');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
