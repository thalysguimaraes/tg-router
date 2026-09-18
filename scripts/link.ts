// Install this repo into omp as the personal-router extension via symlink.
// omp's extension loader follows symlinked directories, so the checkout is the
// single source of truth and edits here are live in the next omp session.
import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const repo = resolve(import.meta.dir, '..');
const target = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'extensions', 'personal-router');

if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    const current = readlinkSync(target);
    if (resolve(current) === repo) { console.log(`already linked: ${target} -> ${repo}`); process.exit(0); }
    console.error(`refusing: ${target} is a symlink to a different path: ${current}`); process.exit(1);
  }
  const backup = `${target}.pre-link-${Date.now()}`;
  renameSync(target, backup);
  console.log(`moved existing directory to ${backup}`);
}
symlinkSync(repo, target, 'dir');
console.log(`linked: ${target} -> ${repo}`);
