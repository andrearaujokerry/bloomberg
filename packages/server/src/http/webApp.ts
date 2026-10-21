/**
 * `http/webApp.ts` — the built web client, served by the plant itself (docs/DEPLOYMENT.md §4.2).
 *
 * In development the browser talks to Vite, which proxies `/api` and `/ws` to the plant. In a
 * deployment there is no Vite, and the page and the API must share ONE origin: the client is built
 * on `RestClient({ baseUrl: window.location.origin })`, and the session cookie is `SameSite=Strict`
 * (§2.1). So the plant serves `packages/web/dist` itself, switched on by `WEB_DIST_DIR`. Unset — every
 * test, and `npm run dev` — nothing here is registered and nothing changes.
 *
 * What it serves, and what it deliberately does not:
 *
 *  - **Every file of the build**, each as its own route (`wildcard: false`: the build does not change
 *    while the process runs, so the file list is read once at startup).
 *  - **`index.html` for any other GET that looks like a page** — no file extension, and not under
 *    `/api/`, `/ws`, `/metrics` or `/health`. The terminal is one page, so a reload on any path it
 *    might put in the address bar still loads it.
 *  - **Nothing for a missing asset.** `/assets/index-OLDHASH.js` after a redeploy is a 404, not the
 *    HTML page with a 200 — a script tag fed HTML fails with a parse error that names nothing.
 *  - **Nothing for an unknown API path.** `/api/v1/nope` stays the JSON `NOT_FOUND` envelope the
 *    client parses (API.md §2); answering an API call with a web page would be a lie with a 200.
 *
 * Caching: the build fingerprints everything under `assets/`, so those are cached for a year and
 * marked immutable; `index.html` is `no-cache`, so a deploy reaches the next load. The page also
 * refuses to be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`): it carries a sign-in
 * form, and a sign-in form inside someone else's frame is how clickjacking starts.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Paths that are never the web page, whatever they are missing. */
const NOT_THE_PAGE = ['/api/', '/ws', '/metrics', '/health'] as const;

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * `WEB_DIST_DIR` as an absolute directory that holds `index.html`.
 *
 * A relative value is tried against the repository root and then the working directory (Render runs
 * from the root; a person may not). A directory without `index.html` is a broken or missing build,
 * and that stops startup here rather than serving a site that is all 404s.
 */
export function resolveWebDist(dir: string): string {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const candidates = isAbsolute(dir)
    ? [dir]
    : [resolve(repoRoot, dir), resolve(process.cwd(), dir)];
  const found = candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
  if (found === undefined) {
    throw new Error(
      `WEB_DIST_DIR=${dir}: no index.html in ${candidates.join(' or ')} — build the web client ` +
        '(npm run build) or unset WEB_DIST_DIR',
    );
  }
  return found;
}

/** True for a GET the page should answer: no extension in the last segment, not an API path. */
export function isPagePath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (
    NOT_THE_PAGE.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))
  ) {
    return false;
  }
  const last = path.slice(path.lastIndexOf('/') + 1);
  return !last.includes('.');
}

function setHeaders(root: string) {
  const assets = `${root}${sep}assets${sep}`;
  return (reply: FastifyReply, filePath: string): void => {
    if (filePath.startsWith(assets)) {
      reply.header('Cache-Control', IMMUTABLE);
      return;
    }
    reply.header('Cache-Control', 'no-cache');
    if (filePath.endsWith(`${sep}index.html`)) {
      reply.header('Content-Security-Policy', "frame-ancestors 'none'");
      reply.header('X-Frame-Options', 'DENY');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'same-origin');
    }
  };
}

/** Register the web client from `root` (already resolved by {@link resolveWebDist}). */
export async function webApp(app: FastifyInstance, opts: { root: string }): Promise<void> {
  await app.register(fastifyStatic, {
    root: opts.root,
    prefix: '/',
    wildcard: false,
    index: 'index.html',
    cacheControl: false,
    setHeaders: setHeaders(opts.root),
  });

  app.get('/*', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isPagePath(request.url)) return reply.callNotFound();
    return reply.sendFile('index.html');
  });
}
