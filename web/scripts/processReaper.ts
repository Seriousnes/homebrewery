// The runner scripts' reaper (scripts/testRunner.ts starts it, detached): it outlives a runner that
// is killed hard (TerminateProcess on Windows, SIGKILL, a tool's command timeout), which then can't
// stop what it started, and kills those process trees (API, Vite, Playwright with its browsers).
//
//   node scripts/processReaper.ts <runner pid>      (IPC messages: { add: pid } | { remove: pid } | { done: true })
//
// The runner going away shows as the IPC channel closing; a poll of its pid backs that up.
import { killTreeSync } from './testRunner.ts';

const runnerPid = Number(process.argv[2]);
const pids = new Set<number>();
let done = false;

function runnerAlive(): boolean {
  try {
    process.kill(runnerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function reap(): void {
  if (!done) for (const pid of pids) killTreeSync(pid);
  process.exit(0);
}

process.on('message', (message: { add?: number; remove?: number; done?: boolean }) => {
  if (message.add) pids.add(message.add);
  if (message.remove) pids.delete(message.remove);
  if (message.done) {
    done = true;
    process.exit(0);
  }
});
process.on('disconnect', reap);
setInterval(() => {
  if (!runnerPid || !runnerAlive()) reap();
}, 2000);
