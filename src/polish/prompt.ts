// Stage-2 prompt construction.
//
// Stage-1 owns the wire contract. Stage-2 may reorganize TypeScript declarations
// for reuse and readability, but the contract validator rejects semantic drift.

export interface PolishTarget {
  /** File to edit, absolute path. */
  file: string;
  /** Every API in the file, for naming context. A merged folder file has many. */
  apis: { docName: string; url: string; httpMethod: string }[];
  /** Raw Stage-1 source used as the immutable contract baseline. */
  stage1Content?: string;
  /** Last validated Stage-2 type design for an older Stage-1 shape. */
  previousContent?: string;
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

function previousContext(targets: PolishTarget[]): string {
  const previous = targets.filter((target) => target.previousContent);
  if (previous.length === 0) return '';
  return `\n## Previous validated results\n\nThese are older outputs for the same files. Use them only as design history: keep\nstill-valid names and abstractions, but derive the final contract exclusively from\nthe current files. Never restore a field that no longer exists.\n\n${previous
    .map((target) => `### PREVIOUS: ${target.file}\n\`\`\`ts\n${target.previousContent}\n\`\`\``)
    .join('\n\n')}\n`;
}

export function buildPolishPrompt(targets: PolishTarget[]): string {
  return `You are polishing auto-generated TypeScript API files. Each file was
produced deterministically from a Torna API doc and already compiles.

Files to polish (edit them in place with the Edit tool):
${apiList(targets)}
${previousContext(targets)}
${POLISH_RULES}

Work through the files one at a time. When done, reply with a one-line summary
per file: the old and new primary type/function names.`;
}

export const POLISH_RULES = `## TypeScript design guidance

These rules adapt the relevant guidance from:
- wshobson/agents: typescript-advanced-types
- cursor/plugins: typescript-best-practices

Prefer the simplest reusable model that removes real duplication:
- Extract stable shared fields into a clearly named interface and use \`extends\`.
- Use \`Pick\` / \`Omit\` when they express a small derivation more clearly than
  another copied interface. Use generics only for a genuinely repeated pattern.
- Prefer \`unknown\` to \`any\`. Never add casts or assertions to silence errors.
- Do not introduce conditional, recursive or mapped types merely to look clever.
  Generated API types must remain easy for business developers to read and edit.
- Keep inheritance shallow and dependencies one-way: shared domain contract first,
  operation-specific request/response types second. Prefer one obvious base over
  chains of tiny helper types.
- Preserve one exported replacement for every original API-facing role. Names may
  improve, but a consumer must still have a clear request and response type to import.

## How to reason before editing

1. Read every endpoint name, URL, request type and response type in the file.
2. Group declarations by business entity and operation role, not just textual
   similarity. Treat list/query, export, submit, save-draft and validate as related
   only when their fields describe the same domain concept.
3. Compare property name, optionality, concrete type, enum and validation JSDoc.
   Extract only a coherent shared subset; leave conflicting fields in each derived
   type. Two generic pagination fields alone are never a useful base.
4. Choose the smallest familiar TypeScript feature that expresses the result.
   Prefer a named interface plus \`extends\`; use \`Pick\` / \`Omit\` only when it
   is more readable; introduce a generic only when at least two declarations share
   the same stable type pattern.
5. Read the result as application code. Names should reveal domain, action and
   audience without tracing URLs or deciphering generated numeric suffixes.

## Business-oriented patterns

- **List + export:** extract the shared filters into \`<Domain>FilterParam\` or
  \`<Domain>QueryBaseParam\`; keep pagination/export-only fields on the relevant
  operation type according to the actual wire contract.
- **Submit + save draft:** extract the shared editable payload into
  \`<Domain>SaveBaseParam\`; keep action-specific fields on \`Submit...Param\` and
  \`Save...DraftParam\`. Never weaken required fields to force reuse.
- **Sibling validations:** extract the shared validation context only when it has
  a domain meaning; keep each rule's target/value fields local.
- **Identical response DTOs:** define one domain VO and keep operation-level
  exported aliases where they make call sites clearer.
- Use \`interface\` for object contracts intended for extension, \`type\` for
  unions, primitive aliases and utility-type compositions. Avoid \`IThing\`,
  \`Data2\`, \`Param3\`, \`BaseBase\` and endpoint-name-length type chains.

## Allowed improvements

1. **Reusable type structure.** Find meaningful duplication across every API in
   the file, especially query/export, submit/save-draft and sibling validation
   endpoints. You may add and reorder type declarations, extract shared
   interfaces, add \`extends\`, use \`Pick\` / \`Omit\`, and replace a duplicate
   declaration with an exported alias.

   Prefer this shape:

   \`export interface BillFilterParam { /* shared fields */ }\`
   \`export interface QueryBillParam extends BillFilterParam { /* query-only */ }\`
   \`export interface ExportBillParam extends BillFilterParam { /* export-only */ }\`

   Do NOT pick a base merely because two small types both contain generic fields
   such as \`id\`, \`pageIndex\` or \`pageSize\`. A useful abstraction represents
   one business concept, removes substantial duplication, and has a clear name.
   Keep declarations separate when the resemblance is accidental or field
   validation comments reveal different semantics.

2. **Semantic naming.** Replace mechanical names with domain-meaningful names.
   - Interfaces: \`DeptPageParam\` / \`DeptPageData\` / \`DeptPageItem\` -> names
     reflecting the business entity with \`...Param\` / \`...Data\` / \`...VO\`.
   - Shared bases should describe the common business concept, normally ending
     in \`BaseParam\` or \`CommonParam\`, never a vague \`SharedParam2\`.
   - Request functions use verb-led camelCase names such as
     \`getMerchantDeptPage\`, \`saveBatteryRecord\`, \`exportVehicleList\`.
   - Preserve an existing semantic name from the current or previous validated
     result unless it is clearly wrong; do not create churn for stylistic preference.
   - Rename every reference consistently. Every exported name stays distinct.

3. **Scalar array element types.** Infer a field currently typed \`unknown[]\`
   from its name, JSDoc and surrounding fields:
   - id/code/no/name lists -> \`string[]\`
   - count/amount/index lists -> \`number[]\`
   - date or time ranges -> \`string[]\`
   Leave genuinely ambiguous arrays unchanged.

4. **Comments.** Fix broken or duplicated JSDoc, preserve Chinese descriptions,
   and add a concise Chinese JSDoc to an undocumented named type when its purpose
   is clear. Do not add comments that merely restate the TypeScript syntax.

## Files holding several APIs

Each API starts with \`// <METHOD> <url>  <name>\`. Near-twin gateway APIs such
as \`/2m/...\` and \`/2b/...\` are distinct operations: reflect their audience
in operation-specific names while sharing only genuinely common type structure.
Review the whole file before editing so the abstractions are coherent file-wide.

## Immutable wire contract

The validator rejects the whole file if any rule below is broken:
- Keep one exported request/response role for every original API declaration;
  names may improve, and an interface may become an extending interface or alias,
  but never collapse two operation-specific public roles into a single export.
- Do NOT add, remove or rename object property keys.
- Do NOT change property optionality, readonly modifiers or any already-known property type.
- Do NOT change enum values, pagination wrappers or response shapes.
- Do NOT change or reorder request functions, URL strings, HTTP methods,
  parameter passing, request calls or other runtime code. Only function names
  and referenced type names may change consistently.
- Do NOT introduce \`any\`, \`as\` assertions, non-null assertions or runtime code.
- Do NOT touch \`common.ts\` or change imports from runtime modules.`;

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
          ...(t.previousContent
            ? [
                '#### PREVIOUS VALIDATED TYPE DESIGN (reference only)',
                '```ts',
                t.previousContent,
                '```',
              ]
            : []),
          '#### CURRENT SOURCE TO POLISH',
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
