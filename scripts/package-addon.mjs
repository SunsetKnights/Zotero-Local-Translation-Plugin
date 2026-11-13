// Creates the lightweight XPI with its native runtime. Models stay external.
//
// Usage: node scripts/package-addon.mjs

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ZipWriter, sha256File } from './zip.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
if (process.argv.length > 2) throw new Error('usage: node scripts/package-addon.mjs');
const PKG = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const ADDON = path.join(ROOT, 'build', 'addon');
const DIST = path.join(ROOT, 'dist');
const RUNTIME_DIR = path.join(ROOT, 'resources', 'win-x64');

const XPI = path.join(DIST, `local-translation-${PKG.version}-win-x64-lite.xpi`);

async function listFiles(dir, base = '') {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFiles(full, rel));
    }
    else {
      out.push({ rel, full });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

async function main() {
  if (!fs.existsSync(path.join(ADDON, 'manifest.json'))) {
    throw new Error('build/addon is missing; run npm run build:addon first');
  }
  const addonManifest = JSON.parse(await fsp.readFile(path.join(ADDON, 'manifest.json'), 'utf8'));
  if (addonManifest.version !== PKG.version) throw new Error('addon version is stale; run npm run build:addon');
  const repositoryUrl = PKG.homepage?.replace(/\/$/, '');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/?#]+$/.test(repositoryUrl ?? '')) {
    throw new Error('package.json homepage must identify the GitHub repository');
  }
  const updateUrl = `https://raw.githubusercontent.com/${repositoryUrl.slice('https://github.com/'.length)}/main/updates.json`;
  const zotero = addonManifest.applications?.zotero;
  if (!zotero?.id || addonManifest.homepage_url !== repositoryUrl
    || zotero.update_url !== updateUrl) {
    throw new Error('addon release metadata is stale; check addon/manifest.json and rebuild');
  }
  // The repository root is the published feed. Building only prepares a
  // candidate; publish its XPI before committing the candidate to the root.
  const publishedUpdates = JSON.parse(await fsp.readFile(path.join(ROOT, 'updates.json'), 'utf8'));
  const publishedAddon = publishedUpdates.addons?.[zotero.id];
  if (!Array.isArray(publishedAddon?.updates)
    || publishedAddon.updates.some((entry) => !entry || typeof entry.version !== 'string')) {
    throw new Error('root updates.json must contain an updates array for this plugin ID');
  }
  const files = await listFiles(ADDON);
  if (files.some((file) => /\.gguf(?:\.|$)/i.test(file.rel)
    || file.rel.startsWith('payload/') || file.rel === 'package-manifest.json')) {
    throw new Error('unexpected model or runtime payload in build/addon; rebuild the addon');
  }

  const extra = [];
  const runtimeManifest = JSON.parse(await fsp.readFile(path.join(ROOT, 'resources', 'runtime-manifest.json'), 'utf8'));
  if (!runtimeManifest.files?.some((file) => file.name === 'translator-host.exe')) {
    throw new Error('runtime manifest is missing translator-host.exe; run npm run build:native');
  }
  for (const file of runtimeManifest.files) {
    if (!/^[a-zA-Z0-9_.-]+\.(exe|dll)$/i.test(file.name)) throw new Error(`invalid runtime file: ${file.name}`);
    const full = path.join(RUNTIME_DIR, file.name);
    if ((await fsp.stat(full)).size !== file.bytes || await sha256File(full) !== file.sha256) {
      throw new Error(`runtime does not match manifest: ${file.name}; rebuild the runtime`);
    }
    extra.push({ rel: `payload/runtime/win-x64/${file.name}`, full });
  }
  const packageManifest = {
    schemaVersion: 1,
    mode: 'lite',
    platform: 'win-x64',
    bundledModel: false,
    runtimeBuildId: runtimeManifest.buildId,
  };
  const metadata = [
    { rel: 'package-manifest.json', text: JSON.stringify(packageManifest, null, 2) + '\n' },
    { rel: 'payload/runtime-manifest.json', text: JSON.stringify(runtimeManifest, null, 2) + '\n' },
  ];
  await fsp.mkdir(DIST, { recursive: true });
  await fsp.rm(XPI, { force: true });

  const zip = new ZipWriter(XPI);
  for (const file of files) {
    zip.addFile(file.rel, file.full, { store: false });
  }

  for (const file of metadata) zip.addBuffer(file.rel, file.text);
  for (const file of extra) zip.addFile(file.rel, file.full, { store: false });

  const summary = zip.close();
  const xpiSha = await sha256File(XPI);
  const xpiSize = (await fsp.stat(XPI)).size;
  const releaseTag = `v${PKG.version}`;
  const updateManifest = {
    ...publishedUpdates,
    addons: {
      ...publishedUpdates.addons,
      [zotero.id]: {
        ...publishedAddon,
        updates: [{
          version: PKG.version,
          update_link: `${repositoryUrl}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(path.basename(XPI))}`,
          update_hash: `sha256:${xpiSha}`,
          update_info_url: `${repositoryUrl}/releases/tag/${encodeURIComponent(releaseTag)}`,
          applications: {
            zotero: { strict_min_version: zotero.strict_min_version, strict_max_version: zotero.strict_max_version },
          },
        }, ...publishedAddon.updates.filter((entry) => entry.version !== PKG.version)],
      },
    },
  };
  const updateManifestPath = path.join(DIST, 'updates.json');
  await fsp.writeFile(updateManifestPath, JSON.stringify(updateManifest, null, 2) + '\n', 'utf8');

  const buildManifest = {
    name: 'local-translation',
    version: PKG.version,
    mode: 'lite',
    createdAt: new Date().toISOString(),
    xpi: path.basename(XPI),
    xpiBytes: xpiSize,
    xpiSha256: xpiSha,
    releaseTag,
    entries: summary.entries,
    files: [...files.map((f) => ({ rel: f.rel, bytes: fs.statSync(f.full).size })), ...extra.map((f) => ({ rel: f.rel, bytes: fs.statSync(f.full).size })), ...metadata.map((f) => ({ rel: f.rel, bytes: Buffer.byteLength(f.text) }))],
  };
  const manifestPath = path.join(DIST, 'build-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(buildManifest, null, 2) + '\n', 'utf8');
  const checksums = [`${xpiSha}  ${path.basename(XPI)}`, `${await sha256File(manifestPath)}  build-manifest.json`];
  await fsp.writeFile(path.join(DIST, 'SHA256SUMS'), checksums.join('\n') + '\n', 'utf8');

  console.log(`[package] ${path.basename(XPI)} ${(xpiSize / 1024 / 1024).toFixed(1)} MiB, ${summary.entries} entries`);
  console.log(`[package] sha256 ${xpiSha}`);
  console.log(`[package] publish the XPI in GitHub Release ${releaseTag}; then copy dist/updates.json to the repository root and commit it`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
