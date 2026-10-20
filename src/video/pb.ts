/**
 * The part of Cortico's protobuf wire reader this module needs, kept local on purpose.
 *
 * Hosts that package Cortico for distribution can leave out built-in Worlds they do not run, and
 * `src/worlds/<id>/` goes with them. Importing the reader from `cortico/worlds/bilibili/protobuf.ts`
 * therefore made the whole World fail to load on such a host (Coopanion drops `src/worlds/bilibili`).
 *
 * This is the same code as that file in Cortico (MIT, Copyright (c) 2026 Phantivia; see LICENSE),
 * minus the base64 and nested-field helpers this World does not use. Readings are identical:
 * single-value fields take the last occurrence of the field number, and unreadable input yields
 * null, undefined or an empty string for the caller to handle.
 */

/** One raw field reading. `varint` and `bytes` are exclusive, chosen by wire type. */
export interface PbField {
  readonly field: number;
  readonly wire: number;
  readonly varint?: bigint;
  readonly bytes?: Uint8Array;
}

const TEXT = new TextDecoder('utf-8', { fatal: true });

/** Parses one level of fields; truncated input, a length overrun or an unsupported wire type yields null. */
export function pbDecode(buf: Uint8Array): PbField[] | null {
  const out: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return null;
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field <= 0) return null;
    if (wire === 0) {
      const value = readVarint(buf, i);
      if (!value) return null;
      i = value.next;
      out.push({ field, wire, varint: value.value });
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      const start = len.next;
      const end = start + Number(len.value);
      if (!Number.isSafeInteger(end) || end > buf.length) return null;
      out.push({ field, wire, bytes: buf.subarray(start, end) });
      i = end;
    } else if (wire === 5 || wire === 1) {
      const width = wire === 5 ? 4 : 8;
      if (i + width > buf.length) return null;
      out.push({ field, wire, bytes: buf.subarray(i, i + width) });
      i += width;
    } else {
      return null;
    }
  }
  return out;
}

/** Reads a varint field; undefined when it is missing or outside the safe-integer range. */
export function pbInt(fields: readonly PbField[] | null, field: number): number | undefined {
  const value = pick(fields, field)?.varint;
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isSafeInteger(num) ? num : undefined;
}

/** Decodes a field's bytes as UTF-8; missing bytes, invalid UTF-8 or control characters yield an empty string. */
export function pbText(fields: readonly PbField[] | null, field: number): string {
  const bytes = pick(fields, field)?.bytes;
  if (!bytes) return '';
  let text: string;
  try {
    text = TEXT.decode(bytes);
  } catch {
    return '';
  }
  return hasControlChars(text) ? '' : text;
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function pick(fields: readonly PbField[] | null, field: number): PbField | undefined {
  if (!fields) return undefined;
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (fields[i].field === field) return fields[i];
  }
  return undefined;
}

/** A varint is at most 10 bytes; a missing terminator yields null. */
function readVarint(buf: Uint8Array, from: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = from; i < buf.length && i - from < 10; i += 1) {
    const byte = buf[i];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  return null;
}
