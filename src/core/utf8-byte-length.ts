/**
 * UTF-8 bytes after replacing each unpaired UTF-16 surrogate with U+FFFD.
 * Count code units directly: some Bun platforms disagree on Buffer.byteLength
 * for isolated surrogate halves, which would undercount a streamed byte budget.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes++;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(codeUnit) && isLowSurrogate(value.charCodeAt(index + 1))) {
      bytes += 4;
      index++;
    } else {
      // BMP characters and U+FFFD both occupy three UTF-8 bytes.
      bytes += 3;
    }
  }
  return bytes;
}

/** Incremental byte cost of appending delta without re-encoding the prior text. */
export function utf8AppendByteLength(previous: string, delta: string): number {
  const bytes = utf8ByteLength(delta);
  if (
    isHighSurrogate(previous.charCodeAt(previous.length - 1)) &&
    isLowSurrogate(delta.charCodeAt(0))
  ) {
    // The prior trailing surrogate was charged three bytes. Its matching low
    // surrogate adds only one, completing a four-byte character across chunks.
    return bytes - 2;
  }
  return bytes;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
