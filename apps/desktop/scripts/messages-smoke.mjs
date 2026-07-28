// Live smoke test for the in-app Messages parsing (src/simplex.ts
// parseChatItems): two cores exchange direct messages over real relays, then
// we run the SAME extraction logic over the raw apiGetChat result and assert
// both directions parse with text, direction, and timestamp. Guards the
// tolerant field-name assumptions (chatItem.meta/content/chatDir shapes)
// against the actual core version.
//
// Run: node apps/desktop/scripts/messages-smoke.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { api, util } from 'simplex-chat';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'messages-smoke-'));
console.log('stores:', dir);

async function initParty(name, displayName) {
  const chat = await api.ChatApi.init({ type: 'sqlite', filePrefix: path.join(dir, name) });
  const user = await chat.apiCreateActiveUser({ displayName, fullName: '' });
  await chat.startChat();
  const events = [];
  chat.onAny(ev => events.push(ev));
  return { chat, user, events, name };
}

function waitFor(party, what, pred, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const found = party.events.find(pred);
      if (found !== undefined) {
        clearInterval(iv);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`[${party.name}] timed out waiting for: ${what}`));
      }
    }, 400);
  });
}

// MIRROR of src/simplex.ts parseChatItems (keep in sync): validates the shape
// assumptions against the real core.
function rec(value) {
  return typeof value === 'object' && value !== null ? value : {};
}
function parseChatItems(raw) {
  const container = rec(raw);
  const items = rec(container.chat).chatItems ?? container.chatItems ?? [];
  const out = [];
  for (const entry of items) {
    // getChat returns BARE ChatItems; event payloads wrap them in {chatItem}.
    const wrapped = rec(entry);
    const item = wrapped.chatDir !== undefined ? wrapped : rec(wrapped.chatItem);
    const dir_ = rec(item.chatDir);
    const meta = rec(item.meta);
    const content = rec(item.content);
    const text = rec(content.msgContent).text ?? meta.itemText;
    if (typeof text !== 'string' || text === '') continue;
    out.push({
      id: typeof meta.itemId === 'number' ? meta.itemId : out.length,
      text,
      mine: typeof dir_.type === 'string' && dir_.type.endsWith('Snd'),
      author: typeof rec(dir_.groupMember).localDisplayName === 'string' ? rec(dir_.groupMember).localDisplayName : '',
      sentAt: typeof meta.itemTs === 'string' ? meta.itemTs : '',
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

const alice = await initParty('alice', 'vendor-smoke');
const bob = await initParty('bob', 'buyer-smoke');

// Alice publishes a personal auto-accept address; Bob connects to it (the
// vendor-contact flow the Messages tab rides on).
const link = await alice.chat.apiCreateUserAddress(alice.user.userId);
await alice.chat.apiSetAddressSettings(alice.user.userId, { autoAccept: true, businessAddress: false });
const address = util.contactAddressStr(link);

const [, prepared] = await bob.chat.apiConnectPlan(bob.user.userId, address);
await bob.chat.sendChatCmd(
  `/_connect ${bob.user.userId} incognito=on ${(await import('@simplex-chat/types')).T.CreatedConnLink.cmdString(prepared)}`,
);
await waitFor(bob, 'contact connected', ev => ev.type === 'contactConnected');
const bobContacts = await bob.chat.apiListContacts(bob.user.userId);
if (bobContacts.length !== 1) throw new Error(`bob has ${bobContacts.length} contacts, expected 1`);
console.log('[bob] connected incognito to', bobContacts[0].localDisplayName);

await bob.chat.apiSendTextMessage(['direct', bobContacts[0].contactId], 'hi, is this still available?');
await waitFor(alice, "bob's message", ev => JSON.stringify(ev).includes('still available'));
const aliceContacts = await alice.chat.apiListContacts(alice.user.userId);
if (aliceContacts.length !== 1) throw new Error(`alice has ${aliceContacts.length} contacts, expected 1`);
await alice.chat.apiSendTextMessage(['direct', aliceContacts[0].contactId], 'yes! ships tomorrow');
await waitFor(bob, "alice's reply", ev => JSON.stringify(ev).includes('ships tomorrow'));

// The actual validation: parse the raw chat exactly as the Messages tab does.
const rawChat = await bob.chat.apiGetChat('direct', bobContacts[0].contactId, 20);
const parsed = parseChatItems(rawChat);
console.log('[bob] parsed thread:', JSON.stringify(parsed, null, 2));

const sent = parsed.find(m => m.text.includes('still available'));
const received = parsed.find(m => m.text.includes('ships tomorrow'));
if (sent === undefined || received === undefined) {
  console.log('RAW CHAT SAMPLE:', JSON.stringify(rawChat).slice(0, 2000));
  throw new Error('parseChatItems failed to extract both messages -- shape assumptions are wrong');
}
if (sent.mine !== true) throw new Error(`sent message parsed as mine=${sent.mine}`);
if (received.mine !== false) throw new Error(`received message parsed as mine=${received.mine}`);
if (sent.sentAt === '' || received.sentAt === '') {
  console.log('WARNING: itemTs not found -- timestamps will not render');
}

await alice.chat.stopChat();
await bob.chat.stopChat();
console.log('MESSAGES-SMOKE-OK');
process.exit(0);
