// Shared output-layout helpers. All entrypoints go through these so the
// artifact root, stub and common file stay consistent.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');

/** Artifact root. Deliberately NOT `out/` so build-cleanup tools leave it be. */
export const ARTIFACT_ROOT = 'generated';

export function artifactDir(...parts: string[]): string {
  return join(repoRoot, ARTIFACT_ROOT, ...parts);
}

// Infrastructure files copied next to every generated batch so the output tree
// type-checks on its own.
export function scaffold(dir: string): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(here, 'shared', 'common.ts'), join(dir, 'common.ts'));
  copyFileSync(join(here, 'shared', 'request-stub.ts'), join(dir, '_request-stub.ts'));
}
