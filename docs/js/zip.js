/**
 * zip.js — stored-entry zip writing and random-access zip reading over Blobs.
 *
 * Why not fflate's zipSync/unzipSync: they hold the whole archive in memory,
 * and a library of audiobooks runs to gigabytes. Why not fflate's streaming
 * Zip/Unzip: the writer leaves sizes to a trailing data descriptor, and the
 * streaming reader then finds the end of a stored entry by scanning for the
 * descriptor signature — which turns up by chance inside MP3/M4B data often
 * enough (~1 in 4 × 10⁹ positions) to truncate a restored audiobook.
 *
 * Here, entries are stored (books, audio and covers are already compressed),
 * sizes and CRCs go in the headers, and the archive is assembled as a Blob of
 * [header, entry blob, header, entry blob, …]. The entry blobs are referenced,
 * not copied — export never loads a book into JS memory. Reading goes through
 * the central directory with Blob.slice(), so a stored entry comes back as a
 * zero-copy view of the backup file. ZIP64 is written and read, so neither a
 * >4 GiB library nor a >4 GiB file breaks the archive.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const U32 = 0xffffffff;
const U16 = 0xffff;

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crcUpdate = (crc, bytes) => {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
};

/**
 * CRC-32 of a Blob, read in chunks so a large file is never held whole.
 * `onBytes(n)` reports progress as chunks are consumed.
 */
export const crc32 = async (blob, onBytes = () => {}) => {
  let c = 0xffffffff;
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < blob.size; off += CHUNK) {
    const bytes = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
    c = crcUpdate(c, bytes);
    onBytes(bytes.length);
  }
  return (c ^ 0xffffffff) >>> 0;
};

/** CRC-32 of bytes already in memory. */
export const crc32Bytes = (bytes) => (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;

// ---------------------------------------------------------------------------
// little-endian helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

// 64-bit values are split into two 32-bit halves: numbers above 2^53 aren't
// possible for Blob sizes, so this is exact.
const setU64 = (v, off, n) => {
  v.setUint32(off, n % 0x100000000, true);
  v.setUint32(off + 4, Math.floor(n / 0x100000000), true);
};
const getU64 = (v, off) => v.getUint32(off, true) + v.getUint32(off + 4, true) * 0x100000000;

// DOS date/time for "now". Zip readers show it; nothing depends on it.
const dosTime = (d = new Date()) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/**
 * Build a stored (uncompressed) zip from `entries` = [{ name, blob }].
 *
 * Every entry is read once to compute its CRC; nothing else is read. The
 * returned Blob references the entry blobs rather than copying them.
 *
 * `onProgress({ done, total, name })` reports bytes checksummed so far.
 * `limit` is the ZIP64 threshold — only lowered by tests, which can't easily
 * make a 4 GiB Blob.
 */
export const writeZip = async (entries, { onProgress = () => {}, limit = U32 } = {}) => {
  const total = entries.reduce((n, e) => n + e.blob.size, 0);
  let done = 0;
  const { time, date } = dosTime();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, blob } of entries) {
    const nameBytes = enc.encode(name);
    const crc = await crc32(blob, (n) => {
      done += n;
      onProgress({ done, total, name });
    });
    const size = blob.size;
    const bigSize = size >= limit;
    const bigOffset = offset >= limit;

    // local header — ZIP64 extra carries both sizes when they don't fit
    const localExtra = bigSize ? 20 : 0;
    const local = new DataView(new ArrayBuffer(30 + nameBytes.length + localExtra));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, bigSize ? 45 : 20, true); // version needed
    local.setUint16(6, 0x0800, true);            // UTF-8 names
    local.setUint16(8, 0, true);                 // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bigSize ? U32 : size, true);
    local.setUint32(22, bigSize ? U32 : size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, localExtra, true);
    new Uint8Array(local.buffer).set(nameBytes, 30);
    if (bigSize) {
      const x = 30 + nameBytes.length;
      local.setUint16(x, 0x0001, true);
      local.setUint16(x + 2, 16, true);
      setU64(local, x + 4, size);
      setU64(local, x + 12, size);
    }
    parts.push(local.buffer, blob);
    central.push({ nameBytes, crc, size, offset, bigSize, bigOffset });
    offset += local.byteLength + size;
  }

  // central directory
  const cdStart = offset;
  for (const e of central) {
    // ZIP64 extra holds only the fields that overflowed, in this fixed order
    const extraLen = (e.bigSize ? 16 : 0) + (e.bigOffset ? 8 : 0);
    const extra = extraLen ? 4 + extraLen : 0;
    const cd = new DataView(new ArrayBuffer(46 + e.nameBytes.length + extra));
    const zip64 = e.bigSize || e.bigOffset;
    cd.setUint32(0, SIG_CENTRAL, true);
    cd.setUint16(4, zip64 ? 45 : 20, true);  // version made by
    cd.setUint16(6, zip64 ? 45 : 20, true);  // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.bigSize ? U32 : e.size, true);
    cd.setUint32(24, e.bigSize ? U32 : e.size, true);
    cd.setUint16(28, e.nameBytes.length, true);
    cd.setUint16(30, extra, true);
    cd.setUint16(32, 0, true); // comment
    cd.setUint16(34, 0, true); // disk
    cd.setUint16(36, 0, true); // internal attrs
    cd.setUint32(38, 0, true); // external attrs
    cd.setUint32(42, e.bigOffset ? U32 : e.offset, true);
    new Uint8Array(cd.buffer).set(e.nameBytes, 46);
    if (extra) {
      let x = 46 + e.nameBytes.length;
      cd.setUint16(x, 0x0001, true);
      cd.setUint16(x + 2, extraLen, true);
      x += 4;
      if (e.bigSize) { setU64(cd, x, e.size); setU64(cd, x + 8, e.size); x += 16; }
      if (e.bigOffset) setU64(cd, x, e.offset);
    }
    parts.push(cd.buffer);
    offset += cd.byteLength;
  }
  const cdSize = offset - cdStart;
  const count = central.length;

  // ZIP64 end records when anything in the classic EOCD would overflow
  const need64 = count >= U16 || cdSize >= limit || cdStart >= limit;
  if (need64) {
    const eocd64At = offset;
    const e64 = new DataView(new ArrayBuffer(56));
    e64.setUint32(0, SIG_EOCD64, true);
    setU64(e64, 4, 44);         // size of the rest of this record
    e64.setUint16(12, 45, true);
    e64.setUint16(14, 45, true);
    e64.setUint32(16, 0, true);
    e64.setUint32(20, 0, true);
    setU64(e64, 24, count);
    setU64(e64, 32, count);
    setU64(e64, 40, cdSize);
    setU64(e64, 48, cdStart);
    const loc = new DataView(new ArrayBuffer(20));
    loc.setUint32(0, SIG_LOCATOR64, true);
    loc.setUint32(4, 0, true);
    setU64(loc, 8, eocd64At);
    loc.setUint32(16, 1, true);
    parts.push(e64.buffer, loc.buffer);
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, SIG_EOCD, true);
  eocd.setUint16(8, need64 ? U16 : count, true);
  eocd.setUint16(10, need64 ? U16 : count, true);
  eocd.setUint32(12, need64 ? U32 : cdSize, true);
  eocd.setUint32(16, need64 ? U32 : cdStart, true);
  eocd.setUint16(20, 0, true);
  parts.push(eocd.buffer);

  return new Blob(parts, { type: "application/zip" });
};

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

const view = async (blob, start, end) =>
  new DataView(await blob.slice(start, end).arrayBuffer());

/** Locate the central directory: { cdStart, cdSize, count }. */
const findDirectory = async (blob) => {
  // the EOCD is 22 bytes plus a comment of up to 64 KiB, at the very end
  const tailStart = Math.max(0, blob.size - (22 + 0xffff));
  const tail = await view(blob, tailStart, blob.size);
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) { at = i; break; }
  }
  if (at < 0) throw new Error("Not a zip file (no end-of-directory record)");
  let count = tail.getUint16(at + 10, true);
  let cdSize = tail.getUint32(at + 12, true);
  let cdStart = tail.getUint32(at + 16, true);

  if (count === U16 || cdSize === U32 || cdStart === U32) {
    const locAt = tailStart + at - 20;
    const loc = locAt >= 0 ? await view(blob, locAt, locAt + 20) : null;
    if (loc?.getUint32(0, true) === SIG_LOCATOR64) {
      const e64At = getU64(loc, 8);
      const e64 = await view(blob, e64At, e64At + 56);
      if (e64.getUint32(0, true) !== SIG_EOCD64) throw new Error("Damaged zip (bad ZIP64 record)");
      count = getU64(e64, 32);
      cdSize = getU64(e64, 40);
      cdStart = getU64(e64, 48);
    }
  }
  if (cdStart + cdSize > blob.size) throw new Error("Damaged or incomplete zip file");
  return { cdStart, cdSize, count };
};

/**
 * Read a zip's directory. Returns [{ name, method, size, compressedSize, crc,
 * blob(): Promise<Blob> }]. Entry data isn't touched until blob() is called,
 * and a stored entry's blob() is a zero-copy slice of the archive.
 * `inflate(bytes, size)` decompresses deflated entries (old backups, and zips
 * made by other tools); pass fflate's inflateSync.
 */
export const readZip = async (blob, { inflate } = {}) => {
  const { cdStart, cdSize, count } = await findDirectory(blob);
  const cd = await view(blob, cdStart, cdStart + cdSize);
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== SIG_CENTRAL) throw new Error("Damaged zip (bad directory entry)");
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));

    // ZIP64 extra: only the overflowing fields are present, in this order
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let y = x + 4;
        if (size === U32) { size = getU64(cd, y); y += 8; }
        if (compressedSize === U32) { compressedSize = getU64(cd, y); y += 8; }
        if (offset === U32) offset = getU64(cd, y);
      }
      x += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory

    out.push({
      name, method, size, compressedSize, crc,
      async blob() {
        // the local header's name/extra lengths can differ from the central
        // directory's, so the data offset has to be read from the header
        const lh = await view(blob, offset, offset + 30);
        if (lh.getUint32(0, true) !== SIG_LOCAL) throw new Error(`Damaged zip entry: ${name}`);
        const start = offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const data = blob.slice(start, start + compressedSize);
        if (method === 0) return data;
        if (method === 8 && inflate) {
          const bytes = inflate(new Uint8Array(await data.arrayBuffer()), size ? new Uint8Array(size) : undefined);
          return new Blob([bytes]);
        }
        throw new Error(`Unsupported zip compression (${method}) for ${name}`);
      },
    });
  }
  return out;
};
