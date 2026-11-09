import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGit } from '../../src/git/run.js';

/**
 * Create a throwaway git repository in the OS temp dir.
 * @returns {Promise<{dir:string, git:(...args:string[])=>Promise<string>,
 *   write:(rel:string, content:string|Buffer)=>Promise<void>,
 *   commit:(msg:string)=>Promise<string>, cleanup:()=>Promise<void>}>}
 */
export async function makeTmpRepo() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'livereview-')));
  /** @param {...string} args */
  const git = async (...args) => (await runGit(dir, args)).stdout;
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Test User');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.autocrlf', 'false');
  return {
    dir,
    git,
    async write(rel, content) {
      const full = join(dir, ...rel.split('/'));
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    },
    async commit(msg) {
      await git('add', '-A');
      await git('commit', '-q', '-m', msg);
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
