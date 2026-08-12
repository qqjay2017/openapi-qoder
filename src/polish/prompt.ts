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

export function buildPolishPrompt(targets: PolishTarget[]): string {
  const list = targets
    .map((t) =>
      [
        `- ${t.file}${t.apis.length > 1 ? `  (${t.apis.length} APIs in this one file)` : ''}`,
        ...t.apis.map((a) => `    ${a.httpMethod} ${a.url}  —  ${a.docName}`),
      ].join('\n'),
    )
    .join('\n');

  return `You are polishing auto-generated TypeScript API files. Each file was
produced deterministically from a Torna API doc and already compiles.

Files to polish (edit them in place with the Edit tool):
${list}

## Your ONLY allowed changes

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
- Keep every declaration \`export\`ed.

Work through the files one at a time. When done, reply with a one-line summary
per file: the old and new primary type/function names.`;
}
