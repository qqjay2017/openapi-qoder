// CLI: Stage-2 AI polish over Stage-1 output.
//
//   tsx src/polish-run.ts <projectId>        -> polishes generated/<pid> in place
//   tsx src/polish-run.ts generated/<pid>    -> same, explicit path
//
// Auth: QODER_PERSONAL_ACCESS_TOKEN, or falls back to local `qodercli login`.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { polish, summarize } from './polish/index.js';
import { ARTIFACT_ROOT, artifactDir, repoRoot, scaffold } from './paths.js';

const root = repoRoot;
const arg = process.argv[2];
if (!arg) {
  console.error('Usage: tsx src/polish-run.ts <projectId | generated/<pid>>');
  process.exit(1);
}

// Accept a bare projectId or an explicit path under the artifact root.
const srcDir = isAbsolute(arg)
  ? arg
  : arg.includes('/') || arg.includes('\\')
    ? resolve(root, arg)
    : artifactDir(arg);
const outDir = `${srcDir.replace(/[\\/]$/, '')}-polished`;

if (!existsSync(srcDir)) {
  console.error(`Missing Stage-1 dir ${srcDir}; run \`qgen gen\` first.`);
  process.exit(1);
}

// tsconfig.polish.json below uses repo-relative include/paths, so the tree has
// to live under the repo root.
if (!outDir.startsWith(root + sep)) {
  console.error(`Output dir ${outDir} must live under ${root}.`);
  process.exit(1);
}

// Seed infrastructure (common.ts + _request-stub.ts) in the polished dir.
mkdirSync(outDir, { recursive: true });
scaffold(outDir);

// Dedicated tsconfig so validation only covers the polished tree.
const tsconfigPath = join(root, 'tsconfig.polish.json');
const relOut = outDir.slice(root.length + 1).replace(/\\/g, '/');
writeFileSync(
  tsconfigPath,
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        baseUrl: '.',
        paths: { '@/utils/request': [`./${relOut}/_request-stub.ts`] },
      },
      include: [`${relOut}/**/*.ts`],
    },
    null,
    2,
  ) + '\n',
);

console.log(`Stage-1: ${basename(srcDir)} (${ARTIFACT_ROOT}/)\nStage-2: ${basename(outDir)}\n`);

await polish({
  srcDir,
  outDir,
  tsconfig: tsconfigPath,
  root,
  batchSize: Number(process.env.POLISH_BATCH ?? 4),
  maxTurns: Number(process.env.POLISH_MAX_TURNS ?? 60),
});

summarize(srcDir, outDir);
