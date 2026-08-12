// Tests for the logic shared by the CLI and the extension (hermetic, pure).

import {
  buildFolderTree,
  collectApis,
  commonSlug,
  findFolder,
  mapLimit,
  parseDocUrl,
  slugFromUrl,
} from './core/index.js';
import type { ApiTreeNode } from './torna/client.js';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

function node(p: Partial<ApiTreeNode> & { id: string }): ApiTreeNode {
  return {
    docId: null,
    label: p.id,
    url: '',
    httpMethod: '',
    type: 2,
    parentId: '',
    apiCount: 0,
    ...p,
  };
}

console.log('\nparseDocUrl');
{
  const hash = parseDocUrl('https://doc-dev.qijiswap.com/#/view/K8MmPR78');
  check('reads the hash route id', hash?.id === 'K8MmPR78', hash?.id ?? '(null)');
  check('takes the base URL from the link', hash?.baseUrl === 'https://doc-dev.qijiswap.com');

  const bare = parseDocUrl('K8MmPR78');
  check('accepts a bare docId', bare?.id === 'K8MmPR78');
  check('bare docId has no base URL', bare?.baseUrl === null);

  check('trims surrounding space', parseDocUrl('  K8MmPR78  ')?.id === 'K8MmPR78');
  check('rejects empty input', parseDocUrl('') === null);
  check('rejects a non-id string', parseDocUrl('hello world') === null);
  check(
    'tolerates a trailing slash',
    parseDocUrl('https://h/#/view/ABC/')?.id === 'ABC',
    parseDocUrl('https://h/#/view/ABC/')?.id ?? '(null)',
  );
}

console.log('\nbuildFolderTree');
{
  // Children point at a parent's `id`, never its docId.
  const nodes = [
    node({ id: 'svc', type: 1, parentId: 'not-a-node', label: 'service' }),
    node({ id: 'folderId', docId: 'FOLDER1', type: 2, parentId: 'svc', apiCount: 2 }),
    node({ id: 'a1', docId: 'A1', type: 3, parentId: 'folderId', url: '/2m/x/y' }),
    node({ id: 'a2', docId: 'A2', type: 3, parentId: 'folderId', url: '/2b/x/y' }),
  ];
  const roots = buildFolderTree(nodes);
  check('unknown parentId becomes a root', roots.length === 1 && roots[0]!.id === 'svc');
  check('folder nests under its service group', roots[0]!.children[0]!.id === 'folderId');
  check('apis nest under the folder', roots[0]!.children[0]!.children.length === 2);
  check('collectApis finds every leaf', collectApis(roots[0]!).length === 2);
  check(
    'collectApis skips non-api nodes',
    collectApis(roots[0]!).every((n) => n.type === 3),
  );
}

console.log('\nfindFolder');
{
  const nodes = [
    node({ id: 'folderId', docId: 'FOLDER1', type: 2, label: 'bills' }),
    node({ id: 'A1', docId: 'A1', type: 3, parentId: 'folderId' }),
  ];
  const viaDocId = findFolder(nodes, 'A1', 'FOLDER1');
  check('resolves via the parent docId', viaDocId?.id === 'folderId');
  // Fallback path: detail.parentId missing, so go through the leaf's parentId.
  const viaLeaf = findFolder(nodes, 'A1', undefined);
  check('falls back to the leaf parentId', viaLeaf?.id === 'folderId');
  check('returns null when unresolvable', findFolder(nodes, 'NOPE', undefined) === null);
}

console.log('\nslug helpers');
{
  check('slugFromUrl strips gateway + version', slugFromUrl('/2m/v1.0/foo/page', 'x') === 'foo-page');
  check('slugFromUrl falls back when empty', slugFromUrl('/2m/', 'fallback') === 'fallback');
  // The gateway must be stripped BEFORE the common prefix is taken, or 2m/2b
  // twins diverge at segment 1 and the prefix is always empty. Once stripped,
  // twins are identical, so the whole path is shared.
  check(
    'commonSlug survives 2m/2b twins',
    commonSlug(['/2m/bill/pcv/queryBillPage', '/2b/bill/pcv/queryBillPage'], 'x') ===
      'bill-pcv-queryBillPage',
    commonSlug(['/2m/bill/pcv/queryBillPage', '/2b/bill/pcv/queryBillPage'], 'x'),
  );
  // Divergent last segments stop the prefix — the real 10-API folder case.
  check(
    'commonSlug stops where siblings diverge',
    commonSlug(
      [
        '/2b/bill/pcv/queryBillPage',
        '/2m/bill/pcv/queryBillPage',
        '/2b/bill/pcv/queryBillDetailLease',
        '/2m/bill/pcv/exportPassengerCarOnVehicleBillListToB',
      ],
      'x',
    ) === 'bill-pcv',
    commonSlug(
      [
        '/2b/bill/pcv/queryBillPage',
        '/2m/bill/pcv/queryBillPage',
        '/2b/bill/pcv/queryBillDetailLease',
        '/2m/bill/pcv/exportPassengerCarOnVehicleBillListToB',
      ],
      'x',
    ),
  );
  check(
    'commonSlug falls back with no shared prefix',
    commonSlug(['/2m/a/b', '/2b/c/d'], 'FOLDER1') === 'FOLDER1',
  );
  check('commonSlug of one url is that url', commonSlug(['/2m/v1/foo/page'], 'x') === 'foo-page');
}

console.log('\nmapLimit');
{
  const order: number[] = [];
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    order.push(n);
    return n * 2;
  });
  check('preserves result order', JSON.stringify(out) === JSON.stringify([2, 4, 6, 8, 10]));
  check('visits every item', order.length === 5);
  check('handles an empty list', (await mapLimit([], 3, async () => 1)).length === 0);
}

console.log(failures === 0 ? '\nAll core checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
