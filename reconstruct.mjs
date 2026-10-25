import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.join(root, 'source-bundle');
const outDir = path.join(root, 'folio-app');
const chunks = (await fs.readdir(bundleDir))
  .filter((n) => /^part\d+\.b64$/.test(n))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
if (chunks.length !== 14) throw new Error(`Folio source bundle is incomplete: expected 14 chunks, got ${chunks.length}`);

const archive = Buffer.from((await Promise.all(chunks.map(n => fs.readFile(path.join(bundleDir, n), 'utf8')))).join(''), 'base64');
const u16 = (b, p) => b.readUInt16LE(p);
const u32 = (b, p) => b.readUInt32LE(p);
let eocd = -1;
for (let p = archive.length - 22; p >= Math.max(0, archive.length - 65557); p--) {
  if (archive.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
}
if (eocd < 0) throw new Error('Invalid Folio ZIP: end record not found.');
const count = u16(archive, eocd + 10);
let p = u32(archive, eocd + 16);
const files = [];
for (let i = 0; i < count; i++) {
  if (u32(archive, p) !== 0x02014b50) throw new Error(`Invalid ZIP directory entry ${i}`);
  const method = u16(archive, p + 10);
  const compressedSize = u32(archive, p + 20);
  const uncompressedSize = u32(archive, p + 24);
  const nameLen = u16(archive, p + 28);
  const extraLen = u16(archive, p + 30);
  const commentLen = u16(archive, p + 32);
  const localOffset = u32(archive, p + 42);
  const name = archive.toString('utf8', p + 46, p + 46 + nameLen);
  p += 46 + nameLen + extraLen + commentLen;
  if (name.endsWith('/')) continue;
  if (!name.startsWith('personal-manga-platform/')) throw new Error(`Unexpected bundle path: ${name}`);
  const relative = name.slice('personal-manga-platform/'.length);
  if (!relative || relative.split(/[\\/]/).some(part => part === '..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe bundle path: ${name}`);
  }
  if (u32(archive, localOffset) !== 0x04034b50) throw new Error(`Invalid local file header: ${name}`);
  const localNameLen = u16(archive, localOffset + 26);
  const localExtraLen = u16(archive, localOffset + 28);
  const start = localOffset + 30 + localNameLen + localExtraLen;
  const raw = archive.subarray(start, start + compressedSize);
  let data;
  if (method === 0) data = Buffer.from(raw);
  else if (method === 8) data = inflateRawSync(raw);
  else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
  if (data.length !== uncompressedSize) throw new Error(`Size mismatch for ${name}`);
  files.push({ relative, data });
}
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });
for (const file of files) {
  const target = path.resolve(outDir, file.relative);
  if (!target.startsWith(outDir + path.sep)) throw new Error('Refusing path traversal.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.data);
}
console.log(`Reconstructed Folio into folio-app/ (${files.length} files).`);
