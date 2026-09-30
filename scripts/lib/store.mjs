/**
 * Tiny JSON persistence helpers with atomic-ish writes so a crash halfway
 * through a run never leaves a truncated data file behind.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[store] could not read ${filePath}: ${error.message}`);
    }
    return fallback;
  }
}

export async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}