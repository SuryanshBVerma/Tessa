import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Results } from '../schemas/generated/index.js';
import { validate, type Selection } from '../schemas/index.js';
import { artifactsDir, RunError, writeAtomic } from '../runs/store.js';
import { resolveInside } from '../util/paths.js';
import { loadResults, renderReportHtml, type ReportContext } from './render.js';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const SCREENSHOT = /^screenshots\/[a-z0-9-]+\/[0-9]+-[0-9]+\.(png|jpg|webp)$/;
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

export type { Selection };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RunError('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Builds and validates a selection for a run. Shared by the server and record_selection. */
export function buildSelection(
  results: Results.RunResults,
  input: { selected_test_ids: unknown; target?: unknown; notes?: unknown },
  source: Selection['source'],
): Selection {
  const ids = input.selected_test_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
    throw new RunError('selected_test_ids must be a non-empty list of test ids');
  }
  const known = new Set(results.tests.map((t) => t.test_id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new RunError(`run ${results.run_id} has no tests: ${unknown.join(', ')}`);
  }
  const selection = {
    version: 1,
    run_id: results.run_id,
    selected_test_ids: [...new Set(ids)],
    ...(input.target === undefined ? {} : { target: input.target }),
    created_at: new Date().toISOString(),
    source,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
  const checked = validate('selection', selection);
  if (!checked.ok) {
    throw new RunError(
      `invalid selection: ${checked.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    );
  }
  return checked.value;
}

export function selectionPath(ctx: ReportContext, runId: string): string {
  return artifactsDir(ctx, 'runs', runId, 'selection.json');
}

export function writeSelection(ctx: ReportContext, selection: Selection): void {
  writeAtomic(selectionPath(ctx, selection.run_id), `${JSON.stringify(selection, null, 2)}\n`);
}

export function readSelection(ctx: ReportContext, runId: string): Selection | null {
  const file = selectionPath(ctx, runId);
  if (!existsSync(file)) {
    return null;
  }
  const checked = validate('selection', JSON.parse(readFileSync(file, 'utf8')));
  if (!checked.ok || checked.value.run_id !== runId) {
    throw new RunError(`selection.json for ${runId} is not a valid selection for this run`);
  }
  return checked.value;
}

export interface ReviewInfo {
  run_id: string;
  url: string;
  port: number;
  idle_timeout_minutes: number;
}

/** Serves one run's report on 127.0.0.1 behind a per-session token. */
export class ReviewServer {
  private server: Server | null = null;
  private info: ReviewInfo | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private waiters: ((selection: Selection) => void)[] = [];

  get active(): ReviewInfo | null {
    return this.info;
  }

  async start(ctx: ReportContext, runId: string): Promise<ReviewInfo> {
    await this.stop();
    const results = loadResults(ctx, runId);
    const html = renderReportHtml(ctx, results);
    writeAtomic(artifactsDir(ctx, 'runs', runId, 'report.html'), html);
    const runDir = artifactsDir(ctx, 'runs', runId);
    const token = randomBytes(24).toString('base64url');
    const idleMs = ctx.config.review.idle_timeout_minutes * 60_000;

    const server = createServer((req, res) => {
      this.touch(idleMs);
      this.handle(req, res, { ctx, results, html, runDir, token }).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal error' });
        }
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, HOST, resolve);
    });
    const { port } = server.address() as AddressInfo;
    this.server = server;
    this.info = {
      run_id: runId,
      url: `http://${HOST}:${String(port)}/${token}/`,
      port,
      idle_timeout_minutes: ctx.config.review.idle_timeout_minutes,
    };
    this.touch(idleMs);
    return this.info;
  }

  private touch(idleMs: number): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, idleMs);
    this.idleTimer.unref();
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    env: {
      ctx: ReportContext;
      results: Results.RunResults;
      html: string;
      runDir: string;
      token: string;
    },
  ): Promise<void> {
    const port = this.info?.port;
    // DNS rebinding: a page on another name that resolves to 127.0.0.1 sends its own Host.
    if (port === undefined || req.headers.host !== `${HOST}:${String(port)}`) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const [, given = '', ...rest] = url.pathname.split('/');
    if (!sameToken(given, env.token)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const path = decodeURIComponent(rest.join('/'));

    if (req.method === 'GET' && (path === '' || path === 'report.html')) {
      send(res, 200, env.html, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && SCREENSHOT.test(path)) {
      const file = resolveInside(env.runDir, path);
      if (!existsSync(file)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const ext = path.slice(path.lastIndexOf('.') + 1);
      send(res, 200, readFileSync(file), CONTENT_TYPES[ext] ?? 'application/octet-stream');
      return;
    }
    if (path === 'selection') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (req.headers.origin !== `http://${HOST}:${String(port)}`) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        sendJson(res, 415, { error: 'expected application/json' });
        return;
      }
      try {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const selection = buildSelection(
          env.results,
          {
            selected_test_ids: body.selected_test_ids,
            ...(body.target === undefined ? {} : { target: body.target }),
            ...(body.notes === undefined ? {} : { notes: body.notes }),
          },
          'local-server',
        );
        writeSelection(env.ctx, selection);
        for (const resolve of this.waiters.splice(0)) {
          resolve(selection);
        }
        sendJson(res, 200, { ok: true, count: selection.selected_test_ids.length });
      } catch (error) {
        sendJson(res, 400, {
          error: error instanceof RunError ? error.message : 'invalid request body',
        });
      }
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  /** Resolves with the next selection posted to the server, or null after the timeout. */
  waitForSelection(timeoutMs: number): Promise<Selection | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(null);
      }, timeoutMs);
      const done = (selection: Selection) => {
        clearTimeout(timer);
        resolve(selection);
      };
      this.waiters.push(done);
    });
  }

  async stop(): Promise<boolean> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const server = this.server;
    this.server = null;
    this.info = null;
    if (server === null) {
      return false;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    return true;
  }
}
