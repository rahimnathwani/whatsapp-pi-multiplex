import { mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const canRun = process.platform !== 'win32' && typeof process.getuid === 'function' && spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!canRun)('multiplex credential provisioning', () => {
    it('refuses a dangling token symlink without modifying its target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'wa-provision-'));
        directories.push(root);
        const home = join(root, 'home');
        const credentialDirectory = join(home, '.config', 'whatsapp-pi-multiplex');
        await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
        const victim = join(root, 'victim');
        await symlink(victim, join(credentialDirectory, 'token'));

        const helper = resolve('scripts/provision-multiplex-credential.py');
        const result = spawnSync('python3', [helper, String(process.getuid!()), String(process.getgid!()), home], { encoding: 'utf8' });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('existing credential');
        await expect(stat(victim)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
