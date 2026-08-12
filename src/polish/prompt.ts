// Stage-2 prompt construction.
//
// The polish pass is deliberately narrow: Stage-1 already produced structurally
// correct output, so the agent must only improve NAMES, scalar-array ELEMENT
// TYPES and COMMENTS. Anything structural is off-limits — those mistakes are
// silent at compile time and only surface at runtime.

export interface PolishTarget {
  /** File to edit, absolute path. */
  file: string;
  /** Original API metadata, for naming context. */
  docName: string;
  url: string;
  httpMethod: string;
}

export function buildPolishPrompt(targets: PolishTarget[]): string {
  const list = targets
    .map((t) => `- ${t.file}\n    ${t.httpMethod} ${t.url}  —  ${t.docName}`)
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
   - The exported request function: rename to a verb-led camelCase name that
     reads like an action, e.g. \`getMerchantDeptPage\`, \`saveBatteryRecord\`,
     \`exportVehicleList\`.
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
