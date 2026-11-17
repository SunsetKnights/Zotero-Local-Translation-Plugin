// Verifies a built XPI before it is published: structure, CRCs, hashes, and
// absence of development leftovers.
//
// Usage: node scripts/verify-package.mjs [dist/file.xpi]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listZip, readZipEntry, sha256, sha256File } from './zip.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

const argXpi = process.argv[2];
const results = [];
let failed = false;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) { failed = true; process.exitCode = 1; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

async function hashEntry(zipPath, entry) {
  // readZipEntry already validates the CRC and handles both stored and deflated
  // data; the largest runtime file is ~42 MB, so buffering it here is fine.
  const data = readZipEntry(zipPath, entry.name);
  if (!data) throw new Error(`cannot read entry ${entry.name}`);
  return sha256(data);
}

function peImports(data) {
  const u16 = offset => data.readUInt16LE(offset), u32 = offset => data.readUInt32LE(offset);
  const pe = u32(0x3c), optional = pe + 24, magic = u16(optional);
  if (u16(0) !== 0x5a4d || u32(pe) !== 0x4550 || ![0x10b, 0x20b].includes(magic)) throw new Error('invalid PE header');
  const directories = optional + (magic === 0x20b ? 112 : 96), sections = optional + u16(pe + 20);
  const sectionCount = u16(pe + 6), imports = [];
  if (sections < directories || sections + sectionCount * 40 > data.length) throw new Error('truncated PE headers');
  const offsetOf = (rva, size = 1) => {
    let offset = rva < u32(optional + 60) ? rva : -1;
    for (let i = 0; offset < 0 && i < sectionCount; i++) {
      const section = sections + i * 40, address = u32(section + 12), bytes = u32(section + 16);
      if (rva >= address && rva + size <= address + bytes) offset = u32(section + 20) + rva - address;
    }
    if (offset < 0 || offset + size > data.length) throw new Error('invalid PE import address');
    return offset;
  };
  for (const directory of [1, 13]) { // Normal imports and delay-load imports.
    if (u32(directories - 4) <= directory) continue;
    const entry = directories + directory * 8;
    if (entry + 8 > sections) throw new Error('truncated PE data directories');
    const rva = u32(entry), size = u32(entry + 4), stride = directory === 1 ? 20 : 32;
    if (!rva) continue;
    let terminated = false;
    for (let cursor = 0; cursor + stride <= size; cursor += stride) {
      const descriptor = offsetOf(rva + cursor, stride);
      if (data.subarray(descriptor, descriptor + stride).every(byte => byte === 0)) { terminated = true; break; }
      let nameRva = u32(descriptor + (directory === 1 ? 12 : 4));
      if (directory === 13 && !(u32(descriptor) & 1)) {
        nameRva -= magic === 0x20b ? Number(data.readBigUInt64LE(optional + 24)) : u32(optional + 28);
      }
      const start = offsetOf(nameRva), end = data.indexOf(0, start);
      if (end < 0 || end - start > 256) throw new Error('invalid PE import name');
      offsetOf(nameRva, end - start + 1);
      const name = data.toString('ascii', start, end).toLowerCase();
      if (!/^[a-z0-9_.-]+\.dll$/.test(name)) throw new Error('invalid PE import name');
      imports.push(name);
    }
    if (!terminated) throw new Error('unterminated PE import table');
  }
  return imports;
}

async function main() {
  const xpi = argXpi ? path.resolve(argXpi) : await findXpi();
  check('xpi exists', fs.existsSync(xpi), xpi);
  if (!fs.existsSync(xpi)) return;

  const entries = listZip(xpi);
  const names = new Set(entries.map((e) => e.name));
  check('manifest.json at archive root', names.has('manifest.json'));
  check('bootstrap.js at archive root', names.has('bootstrap.js'));
  check('bundle present', names.has('content/scripts/bundle.js'));
  check('no absolute or traversal names', entries.every((e) => !e.name.startsWith('/') && !e.name.includes('\\') && !e.name.includes('..')), `${entries.length} entries`);
  check('no build/work/node_modules entries', !entries.some((e) => /^(build|work|node_modules|\.git)\//.test(e.name)));

  const textEntries = entries.filter((e) => /\.(js|json|xhtml|ftl|css|txt|md)$/.test(e.name));
  const needles = ['C:\\', 'D:\\', '/Users/', '/home/'];
  let leaked = null;
  for (const entry of textEntries) {
    const data = readZipEntry(xpi, entry.name);
    const text = data.toString('utf8');
    const hit = needles.find((needle) => text.includes(needle));
    if (hit) {
      leaked = `${entry.name}: ${hit}`;
      break;
    }
  }
  check('no absolute source paths in text assets', leaked === null, leaked ?? `${textEntries.length} text assets scanned`);

  let crcFailures = 0;
  for (const entry of entries) {
    try {
      readZipEntry(xpi, entry.name);
    }
    catch {
      crcFailures++;
    }
  }
  check('all entries pass CRC', crcFailures === 0, `${entries.length} entries`);

  check('no model payload or model checksum manifest', !entries.some((e) => /\.gguf(?:\.|$)/i.test(e.name)
    || e.name.startsWith('payload/models/') || e.name === 'payload/model-manifest.json'));
  let packageManifest;
  try {
    packageManifest = JSON.parse(readZipEntry(xpi, 'package-manifest.json')?.toString('utf8') ?? 'null');
  }
  catch {
    packageManifest = null;
  }
  const validMode = packageManifest?.schemaVersion === 1
    && packageManifest.mode === 'lite'
    && packageManifest.bundledModel === false && packageManifest.platform === 'win-x64';
  check('explicit package mode', validMode, packageManifest?.mode ?? 'missing');
  if (!validMode) return;

  const manifestData = readZipEntry(xpi, 'payload/runtime-manifest.json');
  check('runtime manifest inside payload', Boolean(manifestData));
  if (!manifestData) return;
  const runtimeManifest = JSON.parse(manifestData.toString('utf8'));
  check('runtime build matches package', runtimeManifest.buildId === packageManifest.runtimeBuildId);
  check('helper declared in runtime manifest', runtimeManifest.files.some((file) => file.name === 'translator-host.exe'));
  const runtimeNames = new Set(runtimeManifest.files.map((file) => `payload/runtime/win-x64/${file.name}`));
  check('runtime has no undeclared files', entries.filter((entry) => entry.name.startsWith('payload/runtime/'))
    .every((entry) => runtimeNames.has(entry.name)));
  for (const file of runtimeManifest.files) {
    const validFile = /^[a-zA-Z0-9_.-]+\.(exe|dll)$/i.test(file.name)
      && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes > 0;
    check(`runtime ${file.name} manifest valid`, validFile);
    if (!validFile) continue;
    const entry = entries.find((e) => e.name === `payload/runtime/win-x64/${file.name}`);
    check(`runtime ${file.name} present`, Boolean(entry));
    if (entry) {
      check(`runtime ${file.name} size matches`, entry.uncompressedSize === file.bytes);
      const sha = await hashEntry(xpi, entry);
      check(`runtime ${file.name} sha256 matches`, sha === file.sha256, sha.slice(0, 16) + '…');
    }
  }

  const runtimeEntries = entries.filter(entry => /^payload\/runtime\/win-x64\/[^/]+\.(exe|dll)$/i.test(entry.name));
  const bundledDlls = new Set(runtimeEntries.filter(entry => /\.dll$/i.test(entry.name)).map(entry => path.posix.basename(entry.name).toLowerCase()));
  // Vulkan's optional backend uses the loader installed by the GPU driver.
  const systemDlls = new Set(['kernel32.dll', 'advapi32.dll', 'crypt32.dll', 'shell32.dll', 'ws2_32.dll',
    'psapi.dll', 'ole32.dll', 'oleaut32.dll', 'vulkan-1.dll']);
  for (const entry of runtimeEntries) {
    try {
      const missing = [...new Set(peImports(readZipEntry(xpi, entry.name)))].filter(name => !bundledDlls.has(name)
        && !systemDlls.has(name) && !/^(api-ms-win|ext-ms-win)-[a-z0-9-]+\.dll$/.test(name));
      check(`runtime ${path.posix.basename(entry.name)} dependencies bundled`, missing.length === 0, missing.join(', '));
    }
    catch (error) { check(`runtime ${path.posix.basename(entry.name)} PE imports valid`, false, error.message); }
  }

  const addonManifest = JSON.parse(readZipEntry(xpi, 'manifest.json').toString('utf8'));
  const repositoryUrl = addonManifest.homepage_url?.replace(/\/$/, '');
  const zotero = addonManifest.applications?.zotero;
  check('GitHub homepage configured', /^https:\/\/github\.com\/[^/]+\/[^/?#]+$/.test(repositoryUrl ?? ''));
  const updateUrl = `https://raw.githubusercontent.com/${repositoryUrl?.slice('https://github.com/'.length)}/main/updates.json`;
  check('update URL points to repository root manifest', zotero?.update_url === updateUrl);
  const updatesPath = path.join(path.dirname(xpi), 'updates.json');
  check('candidate updates.json accompanies XPI', fs.existsSync(updatesPath));
  if (fs.existsSync(updatesPath)) {
    const updates = JSON.parse(await fsp.readFile(updatesPath, 'utf8'));
    const publishedUpdates = JSON.parse(await fsp.readFile(path.join(ROOT, 'updates.json'), 'utf8'));
    const history = publishedUpdates.addons?.[zotero?.id]?.updates;
    const candidate = updates.addons?.[zotero?.id]?.updates;
    check('published update history preserved', Array.isArray(history) && Array.isArray(candidate)
      && history.filter((item) => item.version !== addonManifest.version)
        .every((item) => candidate.some((entry) => JSON.stringify(entry) === JSON.stringify(item))));
    const update = updates.addons?.[zotero?.id]?.updates?.find((item) => item.version === addonManifest.version);
    check('update entry matches plugin ID and version', Boolean(update));
    if (update) {
      const tag = encodeURIComponent(`v${addonManifest.version}`);
      check('update download targets this release asset', update.update_link === `${repositoryUrl}/releases/download/${tag}/${encodeURIComponent(path.basename(xpi))}`);
      check('update notes point to release page', update.update_info_url === `${repositoryUrl}/releases/tag/${tag}`);
      check('update hash matches XPI', update.update_hash === `sha256:${await sha256File(xpi)}`);
      check('update compatibility matches XPI', update.applications?.zotero?.strict_min_version === zotero.strict_min_version
        && update.applications?.zotero?.strict_max_version === zotero.strict_max_version);
    }
  }

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
}

async function findXpi() {
  const files = (await fsp.readdir(DIST)).filter((f) => f.endsWith('-lite.xpi'));
  if (files.length === 0) throw new Error('no lightweight xpi in dist/; run npm run package first');
  const dated = await Promise.all(files.map(async (name) => ({ name, modified: (await fsp.stat(path.join(DIST, name))).mtimeMs })));
  dated.sort((a, b) => b.modified - a.modified);
  return path.join(DIST, dated[0].name);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
