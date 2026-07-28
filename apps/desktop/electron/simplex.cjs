// SimpleX messaging core (AD-6), embedded in the Electron MAIN process: the
// simplex-chat package loads the chat core as a native N-API addon with a
// SQLite store, neither of which can live in the sandboxed renderer. The
// renderer drives it over a narrow invoke-style IPC bridge (see preload.cjs)
// and receives core events on the 'simplex:event' channel.
//
// One core database holds MULTIPLE user profiles (one per market identity --
// the per-market SimpleX profile is what keeps markets unlinkable at the
// messaging layer). The renderer owns the market -> userId mapping.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Lazy singletons: nothing SimpleX-related loads until the renderer asks.
let modPromise = null; // import('simplex-chat')
let chatPromise = null; // ChatApi instance
let started = false;

function loadModule() {
  if (modPromise === null) {
    modPromise = import('simplex-chat');
    modPromise.catch(() => {
      modPromise = null;
    });
  }
  return modPromise;
}

async function ensureChat() {
  if (chatPromise === null) {
    chatPromise = (async () => {
      const { api } = await loadModule();
      const dir = path.join(app.getPath('userData'), 'simplex');
      await fs.promises.mkdir(dir, { recursive: true });
      return api.ChatApi.init({ type: 'sqlite', filePrefix: path.join(dir, 'core') });
    })();
    chatPromise.catch(() => {
      chatPromise = null;
    });
  }
  return chatPromise;
}

function broadcast(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('simplex:event', payload);
  }
}

async function addressSettings(chat, userId, { business, welcomeMessage }) {
  await chat.apiSetAddressSettings(userId, {
    autoAccept: true,
    businessAddress: business,
    ...(welcomeMessage ? { welcomeMessage } : {}),
  });
}

// User-scoped core commands are validated against the ACTIVE user (the core
// throws differentActiveUser otherwise), so every user-scoped handler
// switches first. Cheap when already active.
async function activateUser(chat, userId) {
  const active = await chat.apiGetActiveUser();
  if (active === undefined || active.userId !== userId) {
    await chat.apiSetActiveUser(userId);
  }
}

// Network-touching commands need the messaging loop running, but nothing
// starts it for EXISTING profiles (creation and the Messages tab do; a cold
// app going straight to e.g. open-dispute hit "chatNotStarted"). Guarantee it
// here: start once per app session as soon as any profile exists.
async function ensureStartedChat() {
  const chat = await ensureChat();
  if (!started) {
    const active = await chat.apiGetActiveUser();
    if (active !== undefined) {
      await chat.startChat();
      chat.onAny(event => broadcast(event));
      started = true;
    }
  }
  return chat;
}

// The invoke surface. Every handler returns JSON-serializable data; thrown
// errors propagate to the renderer's invoke() rejection with their message.
const handlers = {
  /** Cheap probe: never initializes anything. */
  async status() {
    if (chatPromise === null) {
      return { initialized: false, started: false, users: [] };
    }
    const chat = await ensureChat();
    const users = await chat.apiListUsers();
    return { initialized: true, started, users };
  },

  /** Opens (or creates) the core database and lists profiles. */
  async init() {
    const chat = await ensureChat();
    return { users: await chat.apiListUsers() };
  },

  /** Creates a new user profile and makes it active. */
  async createUser(displayName) {
    const chat = await ensureChat();
    return chat.apiCreateActiveUser({ displayName, fullName: '' });
  },

  async setActiveUser(userId) {
    const chat = await ensureChat();
    return chat.apiSetActiveUser(userId);
  },

  /**
   * Starts the messaging loop (needs at least one profile) and begins
   * forwarding every core event to the renderer.
   */
  async start() {
    const chat = await ensureChat();
    if (started) {
      return { started: true };
    }
    const active = await chat.apiGetActiveUser();
    if (active === undefined) {
      throw new Error('cannot start the SimpleX core: no user profile exists yet');
    }
    await chat.startChat();
    chat.onAny(event => broadcast(event));
    started = true;
    return { started: true };
  },

  /**
   * Creates (or returns) the user's contact address. `business: true` makes
   * it a business address: every connecting contact lands in a fresh group
   * with the owner -- the per-dispute group primitive.
   */
  async createAddress(userId, options) {
    const { util } = await loadModule();
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    const existing = await chat.apiGetUserAddress(userId);
    if (existing !== undefined) {
      await addressSettings(chat, userId, options);
      return util.contactAddressStr(existing.connLinkContact);
    }
    const link = await chat.apiCreateUserAddress(userId);
    await addressSettings(chat, userId, options);
    return util.contactAddressStr(link);
  },

  async getAddress(userId) {
    const { util } = await loadModule();
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    const existing = await chat.apiGetUserAddress(userId);
    return existing === undefined ? null : util.contactAddressStr(existing.connLinkContact);
  },

  /**
   * Connects to a contact/business address link. `incognito` gives this
   * connection a random one-off profile -- what buyers use so a dispute
   * never links back to their market pseudonym or other disputes.
   *
   * UPSTREAM BUG (live-verified 2026-07-17): ChatApi.apiConnect DROPS the
   * incognito argument -- @simplex-chat/types APIConnect.cmdString serializes
   * only the userId and the link, so the core defaults to incognito=off and
   * the caller's profile name leaks to the operator. Send the raw command
   * with the flag inline (the core's own syntax) instead.
   */
  async connect(userId, link, incognito) {
    const { T } = await import('@simplex-chat/types');
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    const [, prepared] = await chat.apiConnectPlan(userId, link);
    const response = await chat.sendChatCmd(
      `/_connect ${userId} incognito=${incognito ? 'on' : 'off'} ${T.CreatedConnLink.cmdString(prepared)}`,
    );
    if (response.type !== 'sentConfirmation' && response.type !== 'sentInvitation') {
      throw new Error(`connect failed: ${JSON.stringify(response).slice(0, 300)}`);
    }
    return response;
  },

  /**
   * Joins a group this profile was invited to. LIVE-VERIFIED: the operator's
   * addMember alone does NOT put the member in the group -- the member's own
   * client must join on receivedGroupInvitation, or the invitation sits
   * unanswered forever.
   */
  async joinGroup(userId, groupId) {
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    return chat.apiJoinGroup(groupId);
  },

  async listContacts(userId) {
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    return chat.apiListContacts(userId);
  },

  async listGroups(userId) {
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    return chat.apiListGroups(userId);
  },

  /** Group-scoped calls run under the profile that owns the group. */
  async listMembers(userId, groupId) {
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    return chat.apiListMembers(groupId);
  },

  async addMember(userId, groupId, contactId, role) {
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    return chat.apiAddMember(groupId, contactId, role);
  },

  /** Sends a text message to a chat ('direct'|'group', id). */
  async sendText(userId, chatType, chatId, text) {
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    return chat.apiSendTextMessage([chatType, chatId], text);
  },

  async getChats(userId) {
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    return chat.apiGetChats(userId, { type: 'last', count: 100 });
  },

  async getChat(userId, chatType, chatId, count) {
    const chat = await ensureStartedChat();
    await activateUser(chat, userId);
    return chat.apiGetChat(chatType, chatId, count);
  },
};

function registerSimplexIpc() {
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`simplex:${name}`, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        // ChatAPIError carries the real reason in `chatError`, which
        // Electron's IPC error serialization DROPS -- fold it into the
        // message so the renderer's error banner shows the actual cause
        // instead of "Chat command error (see chatError property)".
        if (err !== null && typeof err === 'object' && err.chatError !== undefined) {
          throw new Error(`${name}: ${JSON.stringify(err.chatError).slice(0, 500)}`);
        }
        throw err;
      }
    });
  }
}

// Best-effort clean shutdown so the SQLite store closes properly.
async function shutdownSimplex() {
  if (chatPromise === null || !started) {
    return;
  }
  try {
    const chat = await chatPromise;
    await chat.stopChat();
  } catch {
    // Shutdown path: the process is exiting either way.
  }
}

module.exports = { registerSimplexIpc, shutdownSimplex };
