// Arms the repo's pre-push hook after a local `npm install` in this package by
// pointing git at the tracked hooks dir (core.hooksPath=.githooks).
// Safe no-op when this isn't the chrome-bridge repo (e.g. installed as a
// dependency in someone else's project) or when git isn't available.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
  if (root && existsSync(join(root, '.githooks', 'pre-push'))) {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    console.log('[chrome-bridge] pre-push hook armed (core.hooksPath=.githooks)');
  }
} catch {
  // not a git repo / git missing / dependency install — nothing to arm.
}
