// Ledger round-trip test (hermetic, no AI, no shared state).
//
// Verifies the guarantee that makes re-runs safe:
//   apply(stage1, entry)            -> polished
//   harvest(stage1, polished)       -> entry'   (must recover the decisions)
//   apply(stage1, entry')           -> polished (byte-identical)
//
// The seeded entry mirrors what the real Stage-2 agent produced for mock 1.

import { readFileSync } from 'node:fs';
import { applyEntry, harvestEntry, type ApiLedgerEntry } from './ledger/index.js';
import { parseHeader } from './ledger/parse.js';
import { artifactDir } from './paths.js';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const cases: { file: string; entry: Omit<ApiLedgerEntry, 'url' | 'httpMethod' | 'shape'> }[] = [
  {
    file: '1.ts',
    entry: {
      fn: 'getHostingVehiclePage',
      locked: true,
      types: {
        HostingVehiclePageParam: 'HostingVehicleQueryParam',
        HostingVehiclePageItem: 'HostingVehicleVO',
        HostingVehiclePageData: 'HostingVehiclePageResult',
      },
      fieldTypes: {
        'HostingVehiclePageParam.assetOwnerCodes': 'string[]',
        'HostingVehiclePageParam.operatorCodes': 'string[]',
        'HostingVehiclePageParam.operatorNames': 'string[]',
        'HostingVehiclePageParam.createDate': 'string[]',
      },
      source: 'ai',
    },
  },
  {
    file: '5.ts',
    entry: {
      fn: 'getBillPage',
      locked: true,
      types: { PcvQueryBillPageParam: 'BillQueryParam', PcvQueryBillPageItem: 'BillVO' },
      fieldTypes: { 'PcvQueryBillPageParam.bizTypeList': 'BizType[]' },
      source: 'ai',
    },
  },
];

for (const c of cases) {
  const stage1 = readFileSync(artifactDir(c.file), 'utf8');
  const { docId, shape } = parseHeader(stage1);
  console.log(`\n${c.file}  docId=${docId} shape=${shape}`);

  const seeded: ApiLedgerEntry = { url: '', httpMethod: 'POST', shape, ...c.entry };

  // 1) apply
  const polished = applyEntry(stage1, seeded);
  check(
    'apply renamed types',
    Object.values(seeded.types).every((t) => polished.includes(t)),
  );
  check(
    'apply renamed fn',
    !!seeded.fn && polished.includes(`export const ${seeded.fn} =`),
  );
  check(
    'apply resolved unknown[]',
    (polished.match(/unknown\[\]/g) ?? []).length <
      (stage1.match(/unknown\[\]/g) ?? []).length ||
      Object.keys(seeded.fieldTypes).length === 0,
  );
  check('apply left no mechanical names behind', !Object.keys(seeded.types).some((m) => polished.includes(m)));

  // 2) harvest back
  const recovered = harvestEntry(stage1, polished, { url: '', httpMethod: 'POST' });
  if (!recovered) {
    check('harvest returned an entry', false);
    continue;
  }
  check(
    'harvest recovered type map',
    JSON.stringify(recovered.types) === JSON.stringify(seeded.types),
    `${Object.keys(recovered.types).length} type(s)`,
  );
  check(
    'harvest recovered field types',
    JSON.stringify(recovered.fieldTypes) === JSON.stringify(seeded.fieldTypes),
    `${Object.keys(recovered.fieldTypes).length} field(s)`,
  );
  check('harvest recovered fn', recovered.fn === seeded.fn, recovered.fn ?? '(none)');

  // 3) re-apply must be byte-identical => stable across runs
  const again = applyEntry(stage1, recovered);
  check('re-apply is byte-identical', again === polished);
}

// Structural-violation guard: if Stage-2 renamed a property key, harvest must
// refuse rather than record a corrupt mapping.
const stage1 = readFileSync(artifactDir('4.ts'), 'utf8');
const tampered = stage1.replace(/^(\s{2})vin(\??:)/m, '$1vinCode$2');
console.log('\nguard: property renamed by Stage-2');
check('harvest refuses corrupt pair', harvestEntry(stage1, tampered, { url: '', httpMethod: 'POST' }) === null);

console.log(failures === 0 ? '\nAll ledger round-trip checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
