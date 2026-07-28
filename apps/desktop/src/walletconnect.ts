// App-side wallet-connect handler: the wallet end of the @aztec/wallet-sdk
// iframe protocol, running inside the desktop app rather than in the iframe.
//
// The SDK ships this logic as `IframeConnectionHandler`, but that class is
// hardwired to `window.postMessage` (it is meant to run in the wallet iframe).
// Our iframe is a dumb relay (electron/walletconnect.cjs): it forwards raw
// postMessage frames to the app over a localhost WebSocket. So this is a
// faithful re-host of the SDK handler over that frame transport instead of
// `window` -- and, crucially, it reuses the SDK's own crypto (ECDH key
// exchange, AES-GCM, the verification hash) and Wallet schema, so the wire
// protocol and the emoji verification stay byte-for-byte identical to a native
// iframe wallet. The only thing that changes is the transport.
//
// Because it runs in the renderer next to the real EmbeddedWallet, `getWallet`
// returns that wallet directly and dispatch is an ordinary method call -- no
// keys, plaintext, or wallet objects ever cross the relay, only ciphertext.

import type { ChainInfo } from '@aztec/aztec.js/account';
import { WalletSchema, type Wallet } from '@aztec/aztec.js/wallet';
import { jsonStringify } from '@aztec/foundation/json-rpc';
import { getSchemaParameters, parseWithOptionals, schemaHasMethod } from '@aztec/foundation/schemas';
import {
  decrypt,
  deriveSessionKeys,
  encrypt,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  type EncryptedPayload,
  type ExportedPublicKey,
} from '@aztec/wallet-sdk/crypto';
import { WalletMessageType } from '@aztec/wallet-sdk/types';

/**
 * A postMessage frame as it crosses the relay. `connId` identifies which relay
 * iframe/channel it belongs to (the SDK opens several -- a discovery probe plus
 * the real panel -- concurrently), so responses route back to the right one.
 */
export interface RelayFrame {
  /** The relay channel (iframe) this frame belongs to. */
  connId: string;
  /** Target origin for outbound frames, sender origin for inbound. '*' = any. */
  origin: string;
  /** The postMessage payload (a wallet-protocol message). */
  data: Record<string, unknown>;
}

/** The relay transport exposed by preload (electron/walletconnect.cjs). */
export interface WalletConnectBridge {
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  send(frame: RelayFrame): void;
  onFrame(handler: (frame: RelayFrame) => void): () => void;
  onRelay(handler: (payload: { state: 'connected' | 'disconnected'; connId: string }) => void): () => void;
}

/** The discovery probe the SDK sends from a hidden iframe just to learn the
 *  wallet exists; it is not a connection and needs no user approval. */
const DISCOVERY_PROBE_APP_ID = 'discovery-probe';

declare global {
  interface Window {
    marketWalletConnect?: WalletConnectBridge;
  }
}

/** The relay bridge exists only inside the desktop app (not a plain browser tab). */
export function walletConnectAvailable(): boolean {
  return typeof window !== 'undefined' && window.marketWalletConnect !== undefined;
}

export function walletConnectBridge(): WalletConnectBridge {
  const bridge = window.marketWalletConnect;
  if (bridge === undefined) {
    throw new Error('external wallet connection is only available inside the desktop app');
  }
  return bridge;
}

/** A discovery request awaiting the user's approval. */
export interface PendingSession {
  requestId: string;
  appId: string;
  origin: string;
  /** The relay channel this request arrived on. */
  connId: string;
  status: 'pending' | 'approved';
}

/** An established session (after ECDH key exchange). */
export interface ActiveSession {
  sessionId: string;
  sharedKey: CryptoKey;
  verificationHash: string;
  origin: string;
  appId: string;
  /** The relay channel this session's dApp iframe is on. */
  connId: string;
}

export interface WalletConnectConfig {
  walletId: string;
  walletName: string;
  walletVersion: string;
  walletIcon?: string;
  /** Origins allowed to connect. Empty/undefined = allow all (dApps vary). */
  allowedOrigins?: string[];
}

export interface WalletConnectCallbacks {
  onPendingDiscovery?: (session: PendingSession) => void;
  onSessionEstablished?: (session: ActiveSession) => void;
  onSessionTerminated?: (sessionId: string) => void;
  onVerificationHash?: (verificationHash: string) => void;
  /** Resolves the Wallet to dispatch a decrypted request to. */
  getWallet: (appId: string, chainInfo: ChainInfo) => Promise<Wallet>;
}

/**
 * Wallet side of the cross-origin wallet-connect protocol, hosted in the app.
 * Manages discovery, ECDH key exchange, encrypted message dispatch to a
 * {@link Wallet}, and session termination -- mirroring the SDK's
 * IframeConnectionHandler, but over the relay frame transport.
 */
export class WalletConnectHandler {
  private readonly pendingSessions = new Map<string, PendingSession>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private unsubscribeFrame: (() => void) | null = null;
  private unsubscribeRelay: (() => void) | null = null;

  constructor(
    private readonly config: WalletConnectConfig,
    private readonly callbacks: WalletConnectCallbacks,
    private readonly bridge: WalletConnectBridge,
  ) {}

  start(): void {
    if (this.unsubscribeFrame !== null) {
      return;
    }
    this.unsubscribeFrame = this.bridge.onFrame(frame => {
      void this.handleFrame(frame);
    });
    // Announce readiness to a relay iframe whenever its channel (re)connects.
    // Each iframe has its own channel, so WALLET_READY must be addressed to the
    // channel that just came up -- not broadcast. We do NOT drop sessions on
    // 'disconnected': the relay page auto-reconnects (same channel id) after a
    // transient socket blip, and the E2E session keys live on both ends, so a
    // live session resumes seamlessly. Sessions are cleared only by an explicit
    // disconnect (either side) or when the feature is turned off.
    this.unsubscribeRelay = this.bridge.onRelay(({ state, connId }) => {
      if (state === 'connected') {
        this.postTo(connId, '*', { type: WalletMessageType.WALLET_READY });
      }
    });
  }

  stop(): void {
    this.unsubscribeFrame?.();
    this.unsubscribeRelay?.();
    this.unsubscribeFrame = null;
    this.unsubscribeRelay = null;
    this.pendingSessions.clear();
    this.activeSessions.clear();
  }

  approveDiscovery(requestId: string): void {
    const pending = this.pendingSessions.get(requestId);
    if (!pending || pending.status !== 'pending') {
      return;
    }
    pending.status = 'approved';
    this.sendDiscoveryResponse(pending.connId, pending.origin, requestId);
  }

  private sendDiscoveryResponse(connId: string, origin: string, requestId: string): void {
    this.postTo(connId, origin, {
      type: WalletMessageType.DISCOVERY_RESPONSE,
      requestId,
      walletInfo: {
        id: this.config.walletId,
        name: this.config.walletName,
        version: this.config.walletVersion,
        icon: this.config.walletIcon,
      },
    });
  }

  rejectDiscovery(requestId: string): void {
    this.pendingSessions.delete(requestId);
  }

  terminateSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      this.postTo(session.connId, session.origin, {
        type: WalletMessageType.SESSION_DISCONNECTED,
        sessionId,
      });
      this.activeSessions.delete(sessionId);
      this.callbacks.onSessionTerminated?.(sessionId);
    }
  }

  getPendingSessions(): PendingSession[] {
    return Array.from(this.pendingSessions.values()).filter(s => s.status === 'pending');
  }

  getActiveSessions(): ActiveSession[] {
    return Array.from(this.activeSessions.values());
  }

  private async handleFrame(frame: RelayFrame): Promise<void> {
    const { origin, connId } = frame;
    if (this.config.allowedOrigins && this.config.allowedOrigins.length > 0) {
      if (!this.config.allowedOrigins.includes(origin)) {
        return;
      }
    }
    const msg = frame.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case WalletMessageType.DISCOVERY:
        this.handleDiscoveryRequest(msg, origin, connId);
        break;
      case WalletMessageType.KEY_EXCHANGE_REQUEST:
        await this.handleKeyExchangeRequest(msg, origin);
        break;
      case WalletMessageType.SECURE_MESSAGE:
        await this.handleSecureMessage(msg);
        break;
      case WalletMessageType.DISCONNECT:
        this.terminateSession(String(msg.sessionId));
        break;
      case WalletMessageType.PING:
        this.handlePing(String(msg.sessionId));
        break;
    }
  }

  private handlePing(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }
    this.postTo(session.connId, session.origin, { type: WalletMessageType.PONG, sessionId });
  }

  private handleDiscoveryRequest(msg: Record<string, unknown>, origin: string, connId: string): void {
    const requestId = String(msg.requestId);
    const appId = String(msg.appId);
    // The SDK's hidden probe just asks "is a wallet here?" -- answer it directly.
    // It is not a connection, so surfacing an approval prompt for it would show a
    // spurious second request. Consent is gated at the REAL discovery below.
    if (appId === DISCOVERY_PROBE_APP_ID) {
      this.sendDiscoveryResponse(connId, origin, requestId);
      return;
    }
    const pending: PendingSession = { requestId, appId, origin, connId, status: 'pending' };
    this.pendingSessions.set(requestId, pending);
    this.callbacks.onPendingDiscovery?.(pending);
  }

  private async handleKeyExchangeRequest(msg: Record<string, unknown>, origin: string): Promise<void> {
    const requestId = String(msg.requestId);
    const appPublicKeyRaw = msg.publicKey as ExportedPublicKey;
    const pending = this.pendingSessions.get(requestId);
    if (!pending || pending.status !== 'approved') {
      return;
    }
    const keyPair = await generateKeyPair();
    const walletPublicKey = await exportPublicKey(keyPair.publicKey);
    const appPublicKey = await importPublicKey(appPublicKeyRaw);
    // isApp = false: this is the wallet side of the exchange.
    const sessionKeys = await deriveSessionKeys(keyPair, appPublicKey, false);
    const session: ActiveSession = {
      sessionId: requestId,
      sharedKey: sessionKeys.encryptionKey,
      verificationHash: sessionKeys.verificationHash,
      origin: pending.origin,
      appId: pending.appId,
      connId: pending.connId,
    };
    this.activeSessions.set(requestId, session);
    this.pendingSessions.delete(requestId);
    this.postTo(pending.connId, origin, {
      type: WalletMessageType.KEY_EXCHANGE_RESPONSE,
      requestId,
      publicKey: walletPublicKey,
      verificationHash: sessionKeys.verificationHash,
    });
    this.callbacks.onVerificationHash?.(sessionKeys.verificationHash);
    this.callbacks.onSessionEstablished?.(session);
  }

  private async handleSecureMessage(msg: Record<string, unknown>): Promise<void> {
    const sessionId = String(msg.sessionId);
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }
    let walletMessage: {
      messageId: string;
      type: string;
      args: unknown[];
      chainInfo: ChainInfo;
      appId: string;
    };
    try {
      walletMessage = await decrypt(session.sharedKey, msg.encrypted as EncryptedPayload);
    } catch {
      return;
    }
    const { messageId, type, args, chainInfo, appId } = walletMessage;
    let result: unknown;
    let error: string | undefined;
    try {
      const wallet = await this.callbacks.getWallet(appId, chainInfo);
      if (!schemaHasMethod(WalletSchema, type)) {
        throw new Error(`Unknown wallet method: ${type}`);
      }
      const sanitizedArgs = await parseWithOptionals(args, getSchemaParameters(WalletSchema[type]));
      const method = (wallet as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>)[type];
      if (typeof method !== 'function') {
        throw new Error(`Unknown wallet method: ${type}`);
      }
      result = await method.apply(wallet, sanitizedArgs);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const response = { messageId, walletId: this.config.walletId, result, error };
    try {
      const encryptedResponse = await encrypt(session.sharedKey, jsonStringify(response));
      this.postTo(session.connId, session.origin, {
        type: WalletMessageType.SECURE_RESPONSE,
        sessionId,
        encrypted: encryptedResponse,
      });
    } catch {
      /* the dApp's heartbeat will surface the dropped response */
    }
  }

  private postTo(connId: string, origin: string, data: Record<string, unknown>): void {
    this.bridge.send({ connId, origin, data });
  }
}
