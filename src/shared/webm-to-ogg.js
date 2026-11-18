/**
 * Re-boxes a WebM/Opus recording (what Chrome's MediaRecorder makes) as
 * OGG/Opus (what WhatsApp voice notes are). The Opus audio inside is copied
 * as-is, nothing is re-encoded. No chrome APIs, so it can be checked in Node.
 */

/* ---------- WebM (EBML) reading ---------- */

/** Container elements we step into; everything else not listed below is skipped. */
const MASTER_IDS = new Set([
  0x18538067, // Segment
  0x1654ae6b, // Tracks
  0xae, //       TrackEntry
  0xe1, //       Audio
  0x1f43b675, // Cluster
  0xa0, //       BlockGroup
]);
const ID = {
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  CHANNELS: 0x9f,
  SAMPLING_FREQUENCY: 0xb5,
  SIMPLE_BLOCK: 0xa3,
  BLOCK: 0xa1,
};

/**
 * Reads an EBML variable-length integer.
 * @param {Uint8Array} buf
 * @param {number} pos
 * @param {boolean} keepMarker true for element IDs (which keep their length bits)
 * @returns {{value: number, length: number, unknown: boolean} | null} null if it runs past the end
 */
function readVint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (pos + length > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** @returns {number} big-endian unsigned integer */
function readUint(buf, pos, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
  return v;
}

/** @returns {number} big-endian float (4 or 8 bytes) */
function readFloat(buf, pos, size) {
  const view = new DataView(buf.buffer, buf.byteOffset + pos, size);
  return size === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

/**
 * Pulls the Opus track setup and packets out of a WebM file. Containers are
 * walked "flat" (stepped into, not skipped), which also copes with the
 * unknown-size Segment and Clusters MediaRecorder writes while recording.
 * @param {Uint8Array} buf
 * @returns {{opusHead: Uint8Array|null, channels: number, sampleRate: number, packets: Uint8Array[]}}
 */
function readWebmOpus(buf) {
  const tracks = [];
  const packetsByTrack = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const id = readVint(buf, pos, true);
    if (!id) break;
    const size = readVint(buf, pos + id.length, false);
    if (!size) break;
    const start = pos + id.length + size.length;
    if (MASTER_IDS.has(id.value)) {
      if (id.value === ID.TRACK_ENTRY) tracks.push({ number: 0, codec: '', codecPrivate: null, channels: 1, sampleRate: 48000 });
      pos = start; // step into its children
      continue;
    }
    if (size.unknown) break; // only containers may have an unknown size
    const end = start + size.value;
    if (end > buf.length) break; // cut-off last element: keep what we have
    const track = tracks[tracks.length - 1];
    switch (id.value) {
      case ID.TRACK_NUMBER:
        if (track) track.number = readUint(buf, start, size.value);
        break;
      case ID.CODEC_ID:
        if (track) track.codec = new TextDecoder().decode(buf.subarray(start, end));
        break;
      case ID.CODEC_PRIVATE:
        if (track) track.codecPrivate = buf.slice(start, end);
        break;
      case ID.CHANNELS:
        if (track) track.channels = readUint(buf, start, size.value);
        break;
      case ID.SAMPLING_FREQUENCY:
        if (track) track.sampleRate = Math.round(readFloat(buf, start, size.value));
        break;
      case ID.SIMPLE_BLOCK:
      case ID.BLOCK: {
        const trackNo = readVint(buf, start, false);
        const flags = buf[start + trackNo.length + 2];
        if (flags & 0x06) throw new Error('This recording uses a WebM layout the converter does not support (laced blocks).');
        const list = packetsByTrack.get(trackNo.value) || [];
        list.push(buf.slice(start + trackNo.length + 3, end));
        packetsByTrack.set(trackNo.value, list);
        break;
      }
    }
    pos = end;
  }

  const opus = tracks.find((t) => t.codec === 'A_OPUS');
  if (!opus) throw new Error('The recording has no Opus audio.');
  const packets = packetsByTrack.get(opus.number) || [];
  if (!packets.length) throw new Error('The recording is empty.');
  const head = opus.codecPrivate;
  const isHead = head && head.length >= 19 && new TextDecoder().decode(head.subarray(0, 8)) === 'OpusHead';
  return { opusHead: isHead ? head : null, channels: opus.channels, sampleRate: opus.sampleRate, packets };
}

/* ---------- Opus ---------- */

/**
 * Number of 48 kHz samples in one Opus packet, from its TOC byte (RFC 6716 §3.1).
 * @param {Uint8Array} packet
 */
export function opusPacketSamples(packet) {
  const toc = packet[0];
  const config = toc >> 3;
  let frameMs;
  if (config < 12) frameMs = [10, 20, 40, 60][config % 4]; // SILK
  else if (config < 16) frameMs = [10, 20][config % 2]; // hybrid
  else frameMs = [2.5, 5, 10, 20][config % 4]; // CELT
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  return frameMs * 48 * frames;
}

/** OpusHead for when the WebM doesn't carry one (RFC 7845 §5.1). */
function makeOpusHead(channels, sampleRate) {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'));
  const view = new DataView(head.buffer);
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, 312, true); // pre-skip, what Chrome's encoder uses
  view.setUint32(12, sampleRate, true);
  return head; // output gain 0, channel mapping 0
}

function makeOpusTags() {
  const vendor = new TextEncoder().encode('WhatsApp Bulk Sender');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  return tags; // 0 user comments
}

/* ---------- OGG writing ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** OGG's CRC-32 (polynomial 0x04C11DB7, no reflection, init 0). */
export function oggCrc(bytes) {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

/** Lacing values for one packet: 255s, then the remainder (0 if it divides evenly). */
function lacing(length) {
  const out = new Array(Math.floor(length / 255)).fill(255);
  out.push(length % 255);
  return out;
}

/**
 * One OGG page holding whole packets.
 * @param {Uint8Array[]} packets
 * @param {{granule: number, serial: number, seq: number, flags: number}} p
 */
function oggPage(packets, { granule, serial, seq, flags }) {
  const segments = packets.flatMap((pk) => lacing(pk.length));
  const bodyLength = packets.reduce((n, pk) => n + pk.length, 0);
  const page = new Uint8Array(27 + segments.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  page[4] = 0; // version
  page[5] = flags; // 0x02 first page, 0x04 last page
  view.setUint32(6, granule % 2 ** 32, true);
  view.setUint32(10, Math.floor(granule / 2 ** 32), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, seq, true);
  page[26] = segments.length;
  page.set(segments, 27);
  let at = 27 + segments.length;
  for (const pk of packets) {
    page.set(pk, at);
    at += pk.length;
  }
  view.setUint32(22, oggCrc(page), true); // CRC field is 0 while computing
  return page;
}

/**
 * Converts a WebM/Opus recording to an OGG/Opus file.
 * @param {ArrayBuffer|Uint8Array} webm
 * @returns {Uint8Array} the .ogg file
 */
export function webmToOgg(webm) {
  const buf = webm instanceof Uint8Array ? webm : new Uint8Array(webm);
  const { opusHead, channels, sampleRate, packets } = readWebmOpus(buf);
  const serial = (Math.random() * 2 ** 32) >>> 0;
  let seq = 0;
  const pages = [
    oggPage([opusHead || makeOpusHead(channels, sampleRate)], { granule: 0, serial, seq: seq++, flags: 0x02 }),
    oggPage([makeOpusTags()], { granule: 0, serial, seq: seq++, flags: 0 }),
  ];

  // Audio pages: as many whole packets as fit in 255 lacing values (~50 × 20 ms).
  let granule = 0;
  let group = [];
  let groupSegments = 0;
  const flush = (last) => {
    pages.push(oggPage(group, { granule, serial, seq: seq++, flags: last ? 0x04 : 0 }));
    group = [];
    groupSegments = 0;
  };
  for (const [i, pk] of packets.entries()) {
    const segs = Math.floor(pk.length / 255) + 1;
    if (group.length && groupSegments + segs > 255) flush(false);
    group.push(pk);
    groupSegments += segs;
    granule += opusPacketSamples(pk);
    if (i === packets.length - 1) flush(true);
  }

  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
