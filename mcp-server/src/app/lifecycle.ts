import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appUrl } from '../util/app-url.js';
import { existsSync, statSync } from 'node:fs';
import type { ResolvedConfig } from '../config/index.js';
import { resolveInside } from '../util/paths.js';
import { parseCommand, quoteForCmd } from './command.js';

const POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 3000;
const STOP_GRACE_MS = 5000;
const OUTPUT_LINES = 200;
const TAIL_LINES = 40;
const MAX_LINE = 500;

export interface HealthResult {
  healthy: boolean;
  url: string;
  status_code?: number;
  error?: string;
  latency_ms: number;
}

export async function checkHealth(config: ResolvedConfig): Promise<HealthResult> {
  const url = appUrl(config.app.url, config.app.health_path);
  const started = performance.now();
  try {
    // Redirects are not followed: a 302 to /login still means the app is up.
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return {
      healthy: response.status < 500,
      url,
      status_code: response.status,
      latency_ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return {
      healthy: false,
      url,
      error: cause instanceof Error ? cause.message : String(cause),
      latency_ms: Math.round(performance.now() - started),
    };
  }
}

export type StartStatus = 'started' | 'already_running' | 'failed';

export interface StartResult {
  status: StartStatus;
  /** True when Tessa started the app and can stop it. */
  managed: boolean;
  pid?: number;
  health: HealthResult;
  /** Last lines of app output, only when the start failed. */
  output_tail?: string[];
  error?: string;
}

export interface StopResult {
  status: 'stopped' | 'not_running' | 'not_managed';
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts, watches and stops the app under test. One per server; owns at most one process. */
export class AppManager {
  private child: ChildProcess | null = null;
  private exited = false;
  private output: string[] = [];
  private partial = '';

  constructor(private readonly workspace: string) {}

  get pid(): number | undefined {
    return this.running ? this.child?.pid : undefined;
  }

  // A method, not a property read, because event handlers flip it during start(); a direct read
  // would be narrowed to its last assigned value.
  private hasExited(): boolean {
    return this.exited;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  private record(chunk: Buffer): void {
    const lines = (this.partial + chunk.toString('utf8')).split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      this.output.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    }
    if (this.output.length > OUTPUT_LINES) {
      this.output.splice(0, this.output.length - OUTPUT_LINES);
    }
  }

  private spawnApp(config: ResolvedConfig): ChildProcess {
    const { program, args } = parseCommand(config.app.start);
    const cwd = resolveInside(this.workspace, config.app.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`app.cwd "${config.app.cwd}" is not a directory`);
    }
    const env = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' };
    if (process.platform === 'win32') {
      // npm, npx and most dev tools are .cmd shims on Windows, which Node only starts through
      // cmd.exe. parseCommand has already rejected every character cmd.exe would interpret.
      return spawn([program, ...args].map(quoteForCmd).join(' '), {
        cwd,
        env,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    // detached gives the app its own process group so stop() can end the whole tree.
    return spawn(program, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async start(config: ResolvedConfig): Promise<StartResult> {
    const before = await checkHealth(config);
    if (before.healthy) {
      return {
        status: 'already_running',
        managed: this.running,
        ...(this.pid === undefined ? {} : { pid: this.pid }),
        health: before,
      };
    }
    if (this.running) {
      await this.stop();
    }

    this.output = [];
    this.partial = '';
    this.exited = false;
    let spawnError: Error | null = null;
    const child = this.spawnApp(config);
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      this.record(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.record(chunk);
    });
    child.on('error', (error) => {
      spawnError = error;
      this.exited = true;
    });
    child.on('exit', () => {
      this.exited = true;
    });

    const deadline = Date.now() + config.app.start_timeout_seconds * 1000;
    let health = before;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (this.hasExited()) {
        break;
      }
      health = await checkHealth(config);
      if (health.healthy) {
        return {
          status: 'started',
          managed: true,
          ...(child.pid === undefined ? {} : { pid: child.pid }),
          health,
        };
      }
    }

    const exitedEarly = this.hasExited();
    await this.stop();
    const failedSpawn = spawnError as Error | null;
    return {
      status: 'failed',
      managed: false,
      health,
      output_tail: this.tail(),
      error:
        failedSpawn !== null
          ? `could not start "${config.app.start}": ${failedSpawn.message}`
          : exitedEarly
            ? `"${config.app.start}" exited before ${health.url} became healthy`
            : `${health.url} was not healthy within ${String(config.app.start_timeout_seconds)}s`,
    };
  }

  tail(): string[] {
    const lines = this.partial === '' ? this.output : [...this.output, this.partial];
    return lines.slice(-TAIL_LINES);
  }

  async stop(): Promise<StopResult> {
    const child = this.child;
    if (child === null || this.exited || child.pid === undefined) {
      this.child = null;
      return { status: 'not_running', message: 'Tessa has no running app to stop.' };
    }
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });
    killTree(child.pid, 'SIGTERM');
    const graceful = await Promise.race([
      exited.then(() => true),
      sleep(STOP_GRACE_MS).then(() => false),
    ]);
    if (!graceful) {
      killTree(child.pid, 'SIGKILL');
      await Promise.race([exited, sleep(STOP_GRACE_MS)]);
    }
    this.child = null;
    this.exited = true;
    return { status: 'stopped', message: 'Stopped the app Tessa started.' };
  }

  /**
   * Best-effort cleanup when the server shuts down. Synchronous, because the process may exit
   * straight after and an asynchronous kill would never run.
   */
  dispose(): void {
    const pid = this.child?.pid;
    if (pid === undefined || this.exited) {
      return;
    }
    this.exited = true;
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // Already gone.
      }
    } else {
      killTree(pid, 'SIGKILL');
    }
  }
}

function killTree(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (process.platform === 'win32') {
    // taskkill /T ends the cmd.exe shim and everything it started.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      // Already gone is fine.
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}
