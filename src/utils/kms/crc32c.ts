// CRC-32C (Castagnoli), the checksum Cloud KMS puts on every byte string it
// takes and gives: a request names the CRC of its plaintext and the service
// says whether it checked it; a response carries the CRC of what it returns,
// for the caller to check before using it. Node's zlib.crc32 is the IEEE
// polynomial, a different checksum. Table-driven, reflected, 0x82F63B78.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32c(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
