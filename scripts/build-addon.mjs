// Bundles src/ into build/addon and copies the static shell. Produces the
// unpacked plugin directory that packaging turns into an XPI.

import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADDON_SRC = path.join(ROOT, 'addon');
const OUT = path.join(ROOT, 'build', 'addon');
const PKG = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));

async function copyDir(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dst);
    }
    else {
      await fsp.copyFile(src, dst);
    }
  }
}

async function main() {
  const relativeOutput = path.relative(ROOT, OUT);
  if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error('addon output must be inside the project');
  }
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(path.join(OUT, 'content', 'scripts'), { recursive: true });

  await build({
    entryPoints: [path.join(ROOT, 'src', 'index.ts')],
    outfile: path.join(OUT, 'content', 'scripts', 'bundle.js'),
    bundle: true,
    format: 'iife',
    globalName: 'ZoteroTranslateBundle',
    platform: 'neutral',
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'warning',
  });

  for (const file of ['bootstrap.js', 'prefs.js', 'chrome.manifest']) {
    await fsp.copyFile(path.join(ADDON_SRC, file), path.join(OUT, file));
  }

  const manifest = JSON.parse(await fsp.readFile(path.join(ADDON_SRC, 'manifest.json'), 'utf8'));
  manifest.version = PKG.version;
  await fsp.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  await copyDir(path.join(ADDON_SRC, 'content'), path.join(OUT, 'content')).catch(async (e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  await copyDir(path.join(ADDON_SRC, 'locale'), path.join(OUT, 'locale'));
  await copyDir(path.join(ADDON_SRC, 'icons'), path.join(OUT, 'icons'));
  await copyDir(path.join(ROOT, 'resources', 'licenses'), path.join(OUT, 'licenses'));

  let count = 0;
  let bytes = 0;
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const stat = await fsp.stat(full);
        count++;
        bytes += stat.size;
      }
    }
  };
  await walk(OUT);
  console.log(`[build:addon] ${count} files, ${(bytes / 1024).toFixed(1)} KiB in build/addon`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
