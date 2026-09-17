/**
 * WebSocket gateway entry point — **WP-01 stub**. Owned by WP-06 (API.md §6, ARCHITECTURE §6.4,
 * WORKPLAN §1.8 L370-371).
 *
 * The real gateway attaches a `ws` server to the Fastify HTTP server on `/ws/v1`, authenticates the
 * handshake, and owns `ws/{session,conflator,protocol}.ts`. Until WP-06 lands, `registerWsGateway`
 * only records that the gateway is a stub: no upgrade handler is installed, so an upgrade attempt
 * on `/ws/v1` is refused by the HTTP server instead of hanging a client on a socket that will never
 * speak the protocol.
 *
 * The returned handle is what `index.ts` closes on SIGTERM ("send `bye 1001` to every WS session",
 * ARCHITECTURE L1253); the stub has no sessions to say goodbye to.
 */

import type { Clock } from '@terminal/core';
import type { FastifyInstance } from 'fastify';

import type { Config } from '../config.js';
import type { Plant } from '../plant/tickerPlant.js';

/** The gateway's mount path (API.md §6). */
export const WS_PATH = '/ws/v1';

/** The single supported protocol version (OPS-02, API.md §6). */
export const WS_PROTOCOL_VERSION = 1 as const;

export interface WsGatewayDeps {
  config: Config;
  clock: Clock;
  plant: Plant;
}

export interface WsGateway {
  /** Live session count (`StatusResponse.ws.sessions`). */
  sessionCount(): number;
  /** Close every session with `bye 1001` and stop accepting upgrades. */
  close(): Promise<void>;
}

/**
 * Attach the gateway to `app`. WP-06 replaces the body; `app.ts` depends only on this signature.
 */
export function registerWsGateway(app: FastifyInstance, deps: WsGatewayDeps): WsGateway {
  void deps;
  app.log.warn(
    { path: WS_PATH, protocol: WS_PROTOCOL_VERSION },
    'ws gateway is a WP-01 stub: upgrades are not accepted yet (WP-06)',
  );

  return {
    sessionCount(): number {
      return 0;
    },
    async close(): Promise<void> {
      await Promise.resolve();
    },
  };
}
