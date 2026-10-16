import {
  copyFileSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { RunError } from './store.js';

const MAX_BYTES = 10 * 1024 * 1024;

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
 * Copies a screenshot into the run directory and returns its path relative to the run.
 *
 * Host browsers save screenshots wherever they like, so any absolute path is accepted, but only
 * files that really are PNG, JPEG or WebP images (checked by their bytes) and under 10 MB are
 * copied. That keeps this from being a way to pull other files into the run.
 */
export function importScreenshot(
  runDir: string,
  testId: string,
  attempt: number,
  index: number,
  source: ScreenshotSource,
): string {
  let bytes: Buffer | null = null;
  let header: Uint8Array;
  if ('data_base64' in source) {
    const cleaned = source.data_base64.replace(/^data:image\/[a-z]+;base64,/, '');
    bytes = Buffer.from(cleaned, 'base64');
    if (bytes.length > MAX_BYTES) {
      throw new RunError('screenshot is larger than 10 MB');
    }
    header = bytes.subarray(0, 12);
  } else {
    if (!isAbsolute(source.path)) {
      throw new RunError('screenshot path must be absolute');
    }
    let size: number;
    try {
      const stat = statSync(source.path);
      if (!stat.isFile()) {
        throw new RunError('screenshot path is not a file');
      }
      size = stat.size;
    } catch (error) {
      if (error instanceof RunError) throw error;
      throw new RunError('screenshot file does not exist');
    }
    if (size > MAX_BYTES) {
      throw new RunError('screenshot is larger than 10 MB');
    }
    header = new Uint8Array(12);
    const fd = openSync(source.path, 'r');
    try {
      readSync(fd, header, 0, 12, 0);
    } finally {
      closeSync(fd);
    }
  }

  const ext = sniffImage(header);
  if (ext === null) {
    throw new RunError('screenshot must be a PNG, JPEG or WebP image');
  }
  const relative = `screenshots/${testId}/${String(attempt)}-${String(index).padStart(2, '0')}.${ext}`;
  const destination = join(runDir, relative);
  mkdirSync(dirname(destination), { recursive: true });
  if (bytes === null) {
    copyFileSync((source as { path: string }).path, destination);
  } else {
    writeFileSync(destination, bytes);
  }
  return relative;
}
