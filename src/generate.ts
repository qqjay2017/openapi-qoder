// CLI: read mock/*.json Torna detail payloads and emit Stage-1 TypeScript.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateFile, type TornaDetail } from './codegen/emit.js';
import { ARTIFACT_ROOT, artifactDir, repoRoot, scaffold } from './paths.js';

const mockDir = join(repoRoot, 'mock');
const outDir = artifactDir();

scaffold(outDir);

const inputs = readdirSync(mockDir)
  .filter((f) => /^\d+\.json$/.test(f))
  .sort();

for (const file of inputs) {
  const raw = JSON.parse(readFileSync(join(mockDir, file), 'utf8')) as {
    data: TornaDetail;
  };
  const stem = file.replace(/\.json$/, '');
  const code = generateFile(raw.data);
  writeFileSync(join(outDir, `${stem}.ts`), code);
  console.log(`generated ${ARTIFACT_ROOT}/${stem}.ts  (${raw.data.docName})`);
}

console.log(`\nDone. ${inputs.length} file(s) -> ${ARTIFACT_ROOT}/`);
