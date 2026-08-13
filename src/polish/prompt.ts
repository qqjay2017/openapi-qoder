// Stage-2 prompt construction.
//
// The polish pass is deliberately narrow: Stage-1 already produced structurally
// correct output, so the agent must only improve NAMES, scalar-array ELEMENT
// TYPES and COMMENTS. Anything structural is off-limits — those mistakes are
// silent at compile time and only surface at runtime.

export interface PolishTarget {
  /** File to edit, absolute path. */
  file: string;
  /** Every API in the file, for naming context. A merged folder file has many. */
  apis: { docName: string; url: string; httpMethod: string }[];
}

function apiList(targets: PolishTarget[]): string {
  return targets
    .map((t) =>
      [
        `- ${t.file}${t.apis.length > 1 ? `  (${t.apis.length} APIs in this one file)` : ''}`,
        ...t.apis.map((a) => `    ${a.httpMethod} ${a.url}  —  ${a.docName}`),
      ].join('\n'),
    )
    .join('\n');
}

export function buildPolishPrompt(targets: PolishTarget[]): string {
  return `You are polishing auto-generated TypeScript API files. Each file was
produced deterministically from a Torna API doc and already compiles.

Files to polish (edit them in place with the Edit tool):
${apiList(targets)}

${POLISH_RULES}

Work through the files one at a time. When done, reply with a one-line summary
per file: the old and new primary type/function names.`;
}

export const POLISH_RULES = `## Your ONLY allowed changes

1. **Semantic renaming.** Replace mechanical names with domain-meaningful ones.
   - Interfaces: \`DeptPageParam\` / \`DeptPageData\` / \`DeptPageItem\` ->
     names that reflect the business entity, keeping the
     \`...Param\` / \`...Data\` / \`...VO\` suffix convention.
   - The exported request functions: rename each to a verb-led camelCase name
     that reads like an action, e.g. \`getMerchantDeptPage\`,
     \`saveBatteryRecord\`, \`exportVehicleList\`.
   - Rename EVERY reference consistently so the file still compiles.

2. **Scalar array element types.** Fields typed \`unknown[]\` had no element
   metadata in the source doc. Infer the element type from the field name,
   its JSDoc comment and the surrounding fields, then replace \`unknown[]\`:
   - id/code/no/name lists -> \`string[]\`
   - count/amount/index lists -> \`number[]\`
   - date or time range fields (e.g. \`createDate\`, \`billMonth\`) -> \`string[]\`
   - If genuinely ambiguous, leave \`unknown[]\` untouched. Do not guess wildly.

3. **Comment tidying.** Fix obviously broken/duplicated JSDoc text. Keep all
   Chinese descriptions — do not translate them.

## Files holding several APIs

A file may contain MANY APIs, each introduced by its own
\`// <METHOD> <url>  <name>\` comment. Such files often contain near-twin APIs
that differ only in their gateway prefix (\`/2m/...\` vs \`/2b/...\`); Stage-1
distinguished them with a numeric suffix (\`XParam\` and \`X2Param\`).

- Every exported name in the file must stay MUTUALLY DISTINCT. Two declarations
  renamed to the same identifier makes the file uncompilable and the result is
  discarded.
- Preserve the twin distinction as a real one — reflect the gateway or audience
  in the name (e.g. \`...ForMerchant\` vs \`...ForBusiness\`) rather than leaving
  a bare \`2\`.
- Do NOT merge, deduplicate, remove or reorder declarations, even if two look
  identical. Their order and count are the contract used to record your renames.

## Hard constraints — violating these makes the output useless

- Do NOT add, remove, or rename any object PROPERTY key (\`vin\`, \`pageIndex\`, ...).
- Do NOT change optionality (\`?\`) on any property.
- Do NOT change the request URL string or the HTTP method.
- Do NOT restructure types, inline named interfaces, or unwrap \`PageResult<T>\`.
- Do NOT touch \`common.ts\` or the \`import\` of \`PageResult\`.
- Do NOT change enum VALUES (the string literals). You may improve their JSDoc.
- Keep every declaration \`export\`ed.`;

/** A polish target plus its current Stage-1 source, for the text-only cloud pass. */
export interface CloudPolishTarget extends PolishTarget {
  /** File basename — the key the model must echo back. */
  name: string;
  content: string;
}

// The cloud agent has no filesystem access, so the exchange is text-in/text-out:
// inline every file and demand the whole file back. Partial diffs are refused
// because a fenced block is the only thing we can safely write to disk verbatim.
export function buildCloudPolishPrompt(targets: CloudPolishTarget[]): string {
  const files = targets
    .map(
      (t) =>
        [
          `### FILE: ${t.name}`,
          ...t.apis.map((a) => `<!-- ${a.httpMethod} ${a.url}  —  ${a.docName} -->`),
          '```ts',
          t.content,
          '```',
        ].join('\n'),
    )
    .join('\n\n');

  return `You are polishing auto-generated TypeScript API files. Each file was
produced deterministically from a Torna API doc and already compiles.

${POLISH_RULES}

## Output format — deviating from this discards your whole answer

Reply with NOTHING but one section per file, in the order given:

### FILE: <exact file name>
\`\`\`ts
<the complete final content of that file>
\`\`\`

- Emit the ENTIRE file, byte for byte, including the header comments. Never
  abbreviate with \`// ...\`, \`// unchanged\`, or any other placeholder.
- Echo the file name exactly as given. Never invent a file name.
- If a file needs no change, still return it in full, unchanged.
- No prose, no summary, no explanation outside the fenced blocks.

## Files (${targets.length})

${files}`;
}

// `limit` counts APIs, not files: one merged folder file can hold 10 APIs, and
// batching by file count would put a huge reply against a single model turn —
// a truncated reply loses every file in the batch.
export function chunkByApis<T extends PolishTarget>(items: T[], limit: number): T[][] {
  const out: T[][] = [];
  let batch: T[] = [];
  let count = 0;
  for (const item of items) {
    if (batch.length > 0 && count + item.apis.length > limit) {
      out.push(batch);
      batch = [];
      count = 0;
    }
    batch.push(item);
    count += item.apis.length;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}
