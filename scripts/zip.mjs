// Minimal deterministic ZIP writer/reader used for XPI packaging and
// verification. No external dependencies: deflate comes from node:zlib and the
// CRC32 table is built here.
//
// The writer streams file contents straight to disk and patches the local header
// afterwards instead of buffering the complete archive.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export class Crc32 {
  constructor() {
    this.crc = 0xffffffff;
  }

  update(buffer) {
    let c = this.crc;
    for (let i = 0; i < buffer.length; i++) {
      c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    }
    this.crc = c;
  }

  digest() {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.day, 12);
  header.writeUInt32LE(entry.crc >>> 0, 14);
  header.writeUInt32LE(entry.compressedSize >>> 0, 18);
  header.writeUInt32LE(entry.uncompressedSize >>> 0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.day, 14);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.compressedSize >>> 0, 20);
  header.writeUInt32LE(entry.uncompressedSize >>> 0, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(entry.externalAttributes >>> 0, 38);
  header.writeUInt32LE(entry.localOffset >>> 0, 42);
  name.copy(header, 46);
  return header;
}

export class ZipWriter {
  constructor(outputPath) {
    this.outputPath = outputPath;
    this.fd = fs.openSync(outputPath, 'w');
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
  }

  write(buffer) {
    fs.writeSync(this.fd, buffer, 0, buffer.length, this.offset);
    this.offset += buffer.length;
  }

  addBuffer(name, data, { store = false, mode = 0o644 } = {}) {
    this.assertName(name);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = new Crc32();
    crc.update(buffer);
    const compressed = store ? buffer : zlib.deflateRawSync(buffer, { level: 9 });
    const { time, day } = dosDateTime();
    const entry = {
      name,
      method: store ? 0 : 8,
      crc: crc.digest(),
      compressedSize: compressed.length,
      uncompressedSize: buffer.length,
      localOffset: this.offset,
      time,
      day,
      externalAttributes: ((mode & 0xffff) << 16) >>> 0,
    };
    this.write(localHeader(entry));
    this.write(compressed);
    this.entries.push(entry);
  }

  addFile(name, filePath, { store = false, mode = 0o644 } = {}) {
    this.assertName(name);
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const { time, day } = dosDateTime(stat.mtime);
    const entry = {
      name,
      method: store ? 0 : 8,
      crc: 0,
      compressedSize: 0,
      uncompressedSize: size,
      localOffset: this.offset,
      time,
      day,
      externalAttributes: ((mode & 0xffff) << 16) >>> 0,
    };
    const header = localHeader(entry);
    const headerOffset = this.offset;
    this.write(header);

    const crc = new Crc32();
    if (store) {
      const fdIn = fs.openSync(filePath, 'r');
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      try {
        for (;;) {
          const read = fs.readSync(fdIn, chunk, 0, chunk.length, null);
          if (read <= 0) break;
          const slice = chunk.subarray(0, read);
          crc.update(slice);
          this.write(slice);
        }
      }
      finally {
        fs.closeSync(fdIn);
      }
      entry.compressedSize = size;
    }
    else {
      const input = fs.readFileSync(filePath);
      crc.update(input);
      const compressed = zlib.deflateRawSync(input, { level: 9 });
      this.write(compressed);
      entry.compressedSize = compressed.length;
    }
    entry.crc = crc.digest();

    const patched = localHeader(entry).subarray(14, 26);
    fs.writeSync(this.fd, patched, 0, patched.length, headerOffset + 14);
    this.entries.push(entry);
  }

  assertName(name) {
    if (this.names.has(name)) {
      throw new Error(`duplicate zip entry: ${name}`);
    }
    if (name.startsWith('/') || name.includes('\\') || /(^|\/)\.\.(\/|$)/.test(name)) {
      throw new Error(`unsafe zip entry name: ${name}`);
    }
    this.names.add(name);
  }

  close() {
    const centralStart = this.offset;
    for (const entry of this.entries) {
      this.write(centralHeader(entry));
    }
    const centralSize = this.offset - centralStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    this.write(eocd);
    fs.closeSync(this.fd);
    return { entries: this.entries.length, bytes: this.offset };
  }
}

/** Reads the central directory of a zip file without extracting it. */
export function listZip(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLength = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    const eocdIndex = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocdIndex < 0) throw new Error('not a zip file (no end of central directory)');
    const count = tail.readUInt16LE(eocdIndex + 10);
    const centralSize = tail.readUInt32LE(eocdIndex + 12);
    const centralOffset = tail.readUInt32LE(eocdIndex + 16);

    const central = Buffer.alloc(centralSize);
    fs.readSync(fd, central, 0, centralSize, centralOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (central.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
      const method = central.readUInt16LE(p + 10);
      const crc = central.readUInt32LE(p + 16);
      const compressedSize = central.readUInt32LE(p + 20);
      const uncompressedSize = central.readUInt32LE(p + 24);
      const nameLength = central.readUInt16LE(p + 28);
      const extraLength = central.readUInt16LE(p + 30);
      const commentLength = central.readUInt16LE(p + 32);
      const localOffset = central.readUInt32LE(p + 42);
      const name = central.subarray(p + 46, p + 46 + nameLength).toString('utf8');
      entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }
  finally {
    fs.closeSync(fd);
  }
}

/** Reads one entry and verifies its CRC. */
export function readZipEntry(zipPath, name) {
  const entries = listZip(zipPath);
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  const fd = fs.openSync(zipPath, 'r');
  try {
    const local = Buffer.alloc(30);
    fs.readSync(fd, local, 0, 30, entry.localOffset);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const raw = Buffer.alloc(entry.compressedSize);
    fs.readSync(fd, raw, 0, entry.compressedSize, dataStart);
    const data = entry.method === 0 ? raw : zlib.inflateRawSync(raw);
    const crc = new Crc32();
    crc.update(data);
    if (crc.digest() !== entry.crc) {
      throw new Error(`crc mismatch for ${name}`);
    }
    return data;
  }
  finally {
    fs.closeSync(fd);
  }
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}
