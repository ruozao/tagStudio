'use strict';
/**
 * zipcrc.js — ZIP 需要的 CRC32。Node 的 zlib 不导出 crc32，所以自己实现一张表。
 * 多项式 0xEDB88320（反射），与 ZIP/PNG 一致。
 */

let TABLE = null;

function table() {
  if (TABLE) return TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  TABLE = t;
  return t;
}

function crc32(buf, seed = 0) {
  const t = table();
  let c = (seed ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i += 1) {
    c = (t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ -1) >>> 0;
}

module.exports = { crc32 };
