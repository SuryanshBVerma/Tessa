import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { RunError } from './store.js';

const MAX_BYTES = 10 * 1024 * 1024;
/** Longest base64 text that can decode to MAX_BYTES, plus room for a data: URL prefix. */
export const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4 + 64;

const SIGNATURES: { ext: string; bytes: number[]; tail?: number[] }[] = [
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  // RIFF....WEBP
  { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], tail: [0x57, 0x45, 0x42, 0x50] },
];

/** Returns the image type from the file header, or null if it is not a PNG, JPEG or WebP. */
export function sniffImage(header: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    const matches = sig.bytes.every((byte, i) => header[i] === byte);
    const tailMatches =
      sig.tail === undefined || sig.tail.every((byte, i) => header[8 + i] === byte);
    if (matches && tailMatches) {
      return sig.ext;
    }
  }
  return null;
}

export type ScreenshotSource = { path: string } | { data_base64: string };

/**
 * UNC (\\server\share, //server/share) and device paths (\\?\, \\.\). Touching one, even to stat
 * it, makes Windows connect to that server and offer the user's credentials.
 */
function isNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

/** Reads a local file through one handle, so it cannot be swapped between the checks and the copy. */
function readLocalImage(path: string): Buffer {
  if (!isAbsolute(path)) {
    throw new RunError('screenshot path must be absolute');
  }
  if (isNetworkOrDevicePath(path)) {
    throw new RunError('screenshot path must be on this machine, not a network or device path');
  }
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    throw new RunError('screenshot file does not exist');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new RunError('screenshot path is not a file');
    }
    if (stat.size > MAX_BYTES) {
      throw new RunError('screenshot is larger than 10 MB');
    }
    // Read one byte more than allowed, in case the file grew after the stat.
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES) + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
      if (length >= buffer.length) break;
    }
    if (length > MAX_BYTES) {
      throw new RunError('screenshot is larger than 10 MB');
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies a screenshot into the run directory and returns its path relative to the run.
 *
 * Host browsers save screenshots wherever they like, so any absolute local path is accepted, but
 * only files that really are PNG, JPEG or WebP images (checked by their bytes) and under 10 MB
 * are copied. That keeps this from being a way to pull other files into the run.
 */
export function importScreenshot(
  runDir: string,
  testId: string,
  attempt: number,
  index: number,
  source: ScreenshotSource,
): string {
  let bytes: Buffer;
  if ('data_base64' in source) {
    if (source.data_base64.length > MAX_BASE64_CHARS) {
      throw new RunError('screenshot is larger than 10 MB');
    }
    const cleaned = source.data_base64.replace(/^data:image\/[a-z]+;base64,/, '');
    bytes = Buffer.from(cleaned, 'base64');
    if (bytes.length > MAX_BYTES) {
      throw new RunError('screenshot is larger than 10 MB');
    }
  } else {
    bytes = readLocalImage(source.path);
  }

  const ext = sniffImage(bytes.subarray(0, 12));
  if (ext === null) {
    throw new RunError('screenshot must be a PNG, JPEG or WebP image');
  }
  const relative = `screenshots/${testId}/${String(attempt)}-${String(index).padStart(2, '0')}.${ext}`;
  const destination = join(runDir, relative);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  return relative;
}
