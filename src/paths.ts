// Shared output-layout helpers. All entrypoints go through these so the
// artifact root, stub and common file stay consistent.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMON_TS, REQUEST_STUB_TS } from './shared/assets.js';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Artifact root. Deliberately NOT `out/` so build-cleanup tools leave it be. */
export const ARTIFACT_ROOT = 'generated';

export function artifactDir(...parts: string[]): string {
  return join(repoRoot, ARTIFACT_ROOT, ...parts);
}

// Infrastructure files written next to every generated batch so the output tree
// type-checks on its own.
export function scaffold(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'common.ts'), COMMON_TS);
  writeFileSync(join(dir, '_request-stub.ts'), REQUEST_STUB_TS);
}
