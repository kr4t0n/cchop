import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function archiveContents(path: string): string {
  const entries = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n').sort();
  const hash = createHash('sha256');
  for (const entry of entries) {
    assert.ok(entry.startsWith('cchop/') && !entry.includes('..'), 'Unexpected chart archive path');
    const data = execFileSync('tar', ['-xOzf', path, entry]);
    hash.update(`${entry}\0${data.length}\0`).update(data);
  }
  return hash.digest('hex');
}

/** Preserve published chart bytes; changed contents require a new chart version. */
export async function buildHelmRepository(chart: string, pages: string, repositoryUrl: string): Promise<{ version: string; archive: string; changed: boolean }> {
  const url = new URL(repositoryUrl);
  assert.equal(url.protocol, 'https:');
  assert.ok(!url.search && !url.hash && !url.username && !url.password);
  const metadata = parse(await readFile(join(chart, 'Chart.yaml'), 'utf8')) as { name: string; version: string };
  assert.equal(metadata.name, 'cchop');
  assert.match(metadata.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const archive = `cchop-${metadata.version}.tgz`;
  const destination = join(pages, 'helm');
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'cchop-helm-package-'));
  try {
    execFileSync('helm', ['package', chart, '--destination', temporary], { stdio: 'pipe' });
    const candidate = join(temporary, archive);
    const published = join(destination, archive);
    const alreadyPublished = await exists(published);
    if (alreadyPublished) {
      assert.equal(archiveContents(candidate), archiveContents(published), `Chart ${metadata.version} already exists with different contents; bump Chart.yaml version`);
    } else {
      await copyFile(candidate, published, constants.COPYFILE_EXCL);
    }
    const indexPath = join(destination, 'index.yaml');
    const hasIndex = await exists(indexPath);
    if (alreadyPublished && hasIndex) {
      const index = parse(await readFile(indexPath, 'utf8')) as { entries?: { cchop?: { version: string; digest: string; urls: string[] }[] } };
      const entry = index.entries?.cchop?.find((item) => item.version === metadata.version);
      const digest = createHash('sha256').update(await readFile(published)).digest('hex');
      if (entry?.digest === digest && entry.urls.includes(`${repositoryUrl.replace(/\/$/, '')}/${archive}`)) {
        return { version: metadata.version, archive, changed: false };
      }
    }
    execFileSync('helm', ['repo', 'index', destination, '--url', repositoryUrl, ...(hasIndex ? ['--merge', indexPath] : [])], { stdio: 'pipe' });
    return { version: metadata.version, archive, changed: true };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [chart, pages, url] = process.argv.slice(2);
  assert.ok(chart && pages && url, 'Usage: helm-repository.ts <chart directory> <Pages directory> <repository URL>');
  const result = await buildHelmRepository(chart, pages, url);
  process.stdout.write(`${result.changed ? 'Packaged' : 'Preserved'} ${result.archive}\n`);
}
