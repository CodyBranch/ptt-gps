import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Deploying from the console, without the console being able to watch it
 * happen.
 *
 * A deploy restarts the service, so the process that started it is killed
 * partway through and can never report how things ended. Two consequences
 * shape everything here:
 *
 *  - The work runs detached, owned by Task Scheduler. WinSW stops a service by
 *    killing its process tree, so a deploy spawned as a child of the server
 *    would be killed by its own Restart-Service, mid-build, leaving a
 *    half-pulled tree and nothing serving.
 *
 *  - Progress goes to a file beside the database rather than being held in
 *    memory or returned to the caller. It outlives the restart, so the console
 *    can reconnect afterwards and say how it went.
 */

export interface PendingCommit {
  sha: string;
  subject: string;
}

export interface UpdateInfo {
  /** False when this is not a git checkout at all, in which case nothing else applies. */
  repo: boolean;
  branch: string;
  current: string;
  commits: PendingCommit[];
  /** Local edits to code, which block a deploy. Event data is excluded. */
  blockedBy: string[];
  checkedAt: number;
  error?: string;
}

export interface DeployStatus {
  stage: string;
  message: string;
  log: string[];
  done: boolean;
  ok: boolean;
  updatedAt: string;
}

/**
 * Which of git's porcelain lines should stop a deploy.
 *
 * Event configs and courses are operator data that happens to live in the
 * repo. They are dirty by design on a live box, so they are reported but never
 * block.
 *
 * The output is deliberately not trimmed. Porcelain v1 is `XY path`, and an
 * unstaged modification has a leading space, so trimming the whole output eats
 * it on the first line only. That shifts one path by a character and stops it
 * matching -- producing exactly one spurious blocker, which is a far more
 * confusing symptom than all of them being wrong.
 */
export function blockingChanges(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 3)
    .filter((line) => !pathOf(line).startsWith('events/'));
}

/** The path a porcelain line refers to; for a rename, where it ended up. */
function pathOf(line: string): string {
  const rest = line.slice(3);
  const arrow = rest.indexOf(' -> ');
  return (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, '');
}

const TASK_NAME = 'ptt-gps-deploy';

/** Git is not reliably on PATH for a service account, so it is resolved like node. */
function resolveGit(): string | null {
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Git', 'cmd', 'git.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return 'git';
  } catch {
    return null;
  }
}

export class DeployManager {
  private cached: UpdateInfo | null = null;
  private checking: Promise<UpdateInfo> | null = null;
  private readonly git = resolveGit();

  constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly branch = 'main',
  ) {}

  get statusFile(): string {
    return path.join(this.dataDir, 'deploy-status.json');
  }

  private run(args: string[], timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.git) return reject(new Error('git is not installed on this machine'));
      execFile(this.git, args, { cwd: this.root, timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        resolve(stdout);
      });
    });
  }

  /**
   * What is waiting on the remote. Fetching hits the network, so a result is
   * reused until it ages out; the console polls this far more often than the
   * remote actually changes.
   */
  async check(maxAgeMs = 10 * 60_000): Promise<UpdateInfo> {
    if (this.cached && Date.now() - this.cached.checkedAt < maxAgeMs) return this.cached;
    // Collapse concurrent checks: several console tabs polling should not
    // produce several fetches.
    if (this.checking) return this.checking;

    this.checking = this.doCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async doCheck(): Promise<UpdateInfo> {
    const info: UpdateInfo = {
      repo: false,
      branch: this.branch,
      current: 'unknown',
      commits: [],
      blockedBy: [],
      checkedAt: Date.now(),
    };

    if (!fs.existsSync(path.join(this.root, '.git'))) {
      info.error = 'not a git checkout - deploys are only available from a cloned repository';
      this.cached = info;
      return info;
    }
    info.repo = true;

    try {
      await this.run(['fetch', '--quiet', 'origin', this.branch]);
      info.current = (await this.run(['rev-parse', '--short', 'HEAD'])).trim();

      const log = (await this.run(['log', '--oneline', '--no-decorate', `HEAD..origin/${this.branch}`])).trim();
      info.commits = log
        ? log.split('\n').map((line) => {
            const sp = line.indexOf(' ');
            return { sha: line.slice(0, sp), subject: line.slice(sp + 1) };
          })
        : [];

      info.blockedBy = blockingChanges(await this.run(['status', '--porcelain']));
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err);
    }

    this.cached = info;
    return info;
  }

  /** Discard the cache so the next check really fetches. */
  invalidate(): void {
    this.cached = null;
  }

  readStatus(): DeployStatus | null {
    try {
      if (!fs.existsSync(this.statusFile)) return null;
      return JSON.parse(fs.readFileSync(this.statusFile, 'utf8')) as DeployStatus;
    } catch {
      return null;
    }
  }

  /** Record a failure the deploy itself could not report. */
  private fail(message: string): void {
    try {
      const prev = this.readStatus();
      fs.writeFileSync(
        this.statusFile,
        JSON.stringify(
          {
            stage: 'failed',
            message,
            log: [...(prev?.log ?? []), message],
            done: true,
            ok: false,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // Reporting a failure must not become a second failure.
    }
  }

  /**
   * Turn a deploy that was scheduled but never reported in into a recorded
   * failure.
   *
   * Quietly hiding it would leave the operator with no answer at all: they
   * pressed Deploy, something clearly did not happen, and nothing on the page
   * would ever say so.
   */
  reapAbandoned(): void {
    const s = this.readStatus();
    if (!s || s.done || s.stage !== 'starting') return;
    if (Date.now() - new Date(s.updatedAt).getTime() < 2 * 60_000) return;
    this.fail('The deploy was scheduled but never started. Nothing was changed.');
  }

  /** True while a deploy started earlier has not reported an ending. */
  inProgress(): boolean {
    const s = this.readStatus();
    if (!s || s.done) return false;
    const idleMs = Date.now() - new Date(s.updatedAt).getTime();

    // 'starting' is written here, before the task is handed over; every later
    // stage is written by the script itself. So a deploy still on 'starting'
    // after a couple of minutes never got going, and waiting the full timeout
    // makes a hand-off that failed instantly look like a deploy that is
    // merely slow.
    if (s.stage === 'starting' && idleMs > 2 * 60_000) return false;

    // A deploy that stopped reporting is not still running; without this a
    // machine that lost power mid-deploy would refuse every later attempt.
    return idleMs < 30 * 60_000;
  }

  /**
   * Hand the work to Task Scheduler and return. Nothing is awaited: the point
   * is that this runs outside our process tree, and outlives us.
   */
  start(opts: { force?: boolean; by: string }): void {
    if (process.platform !== 'win32') {
      throw new Error('deploys from the console are only supported on Windows');
    }
    if (this.inProgress()) throw new Error('a deploy is already running');

    const script = path.join(this.root, 'deploy', 'update.ps1');
    if (!fs.existsSync(script)) throw new Error(`deploy script not found at ${script}`);

    fs.mkdirSync(this.dataDir, { recursive: true });
    const started: DeployStatus = {
      stage: 'starting',
      message: `Deploy requested by ${opts.by}`,
      log: [`Deploy requested by ${opts.by}`],
      done: false,
      ok: false,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.statusFile, JSON.stringify(started, null, 2));

    // Task Scheduler's /tr takes the whole command as one string, and nesting
    // quotes inside it is a reliable way to produce something that looks right
    // and does not run: the escapes end up stored literally, PowerShell is
    // handed a filename that does not exist, and the task dies in under a
    // second without telling anyone.
    //
    // A one-line wrapper sidesteps it. The task runs a file path with no
    // arguments of its own, and the quoting lives in a .cmd where it behaves
    // the way quoting normally does.
    const runner = path.join(this.dataDir, 'run-deploy.cmd');
    const command =
      `powershell.exe -ExecutionPolicy Bypass -NonInteractive -File "${script}"` +
      ` -Yes${opts.force ? ' -Force' : ''} -StatusFile "${this.statusFile}"`;
    fs.writeFileSync(runner, ['@echo off', command, ''].join('\r\n'));

    // /f replaces a task left behind by a previous deploy; SYSTEM because the
    // service runs as SYSTEM and the tree is written by it.
    const create = [
      '/create',
      '/tn',
      TASK_NAME,
      '/tr',
      runner,
      '/sc',
      'once',
      '/st',
      '00:00',
      '/ru',
      'SYSTEM',
      '/rl',
      'HIGHEST',
      '/f',
    ];

    try {
      execFileSync('schtasks.exe', create, { stdio: 'pipe' });
      execFileSync('schtasks.exe', ['/run', '/tn', TASK_NAME], { stdio: 'pipe' });
    } catch (err) {
      // Otherwise the status file sits on 'starting' and the console shows a
      // deploy that is not running and never will.
      const detail = err instanceof Error ? err.message : String(err);
      this.fail(`could not schedule the deploy: ${detail}`);
      throw new Error(`could not schedule the deploy: ${detail}`);
    }
    this.invalidate();
  }
}
