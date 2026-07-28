// Smoke test for the embedded SimpleX core (AD-6): proves the native addon
// loads, the store initializes, profiles can be created, and a REAL contact
// address can be provisioned on the default SMP relays. Needs internet.
// Run: node apps/desktop/scripts/simplex-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { api, util } from 'simplex-chat';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplex-smoke-'));
console.log('store:', dir);

const chat = await api.ChatApi.init({ type: 'sqlite', filePrefix: path.join(dir, 'core') });
console.log('core initialized');

const user = await chat.apiCreateActiveUser({ displayName: 'smoke-market-a', fullName: '' });
console.log('profile created:', user.userId, user.localDisplayName);

await chat.startChat();
console.log('chat started');

// A second profile: the per-market isolation primitive.
const user2 = await chat.apiCreateActiveUser({ displayName: 'smoke-market-b', fullName: '' });
console.log('second profile:', user2.userId, user2.localDisplayName);
const users = await chat.apiListUsers();
console.log('profiles in store:', users.map(u => u.user.localDisplayName).join(', '));

// Business address with auto-accept: the dispute-intake primitive.
// (User-scoped commands run under the ACTIVE user; switch back to profile A.)
await chat.apiSetActiveUser(user.userId);
const link = await chat.apiCreateUserAddress(user.userId);
await chat.apiSetAddressSettings(user.userId, {
  autoAccept: true,
  businessAddress: true,
  welcomeMessage: 'Dispute intake test',
});
const address = util.contactAddressStr(link);
console.log('business address created:', address.slice(0, 80) + '...');

const fetched = await chat.apiGetUserAddress(user.userId);
if (fetched === undefined) {
  throw new Error('address readback failed');
}
console.log('address settings:', JSON.stringify(util.botAddressSettings(fetched)));

await chat.stopChat();
console.log('SMOKE-OK');
process.exit(0);
