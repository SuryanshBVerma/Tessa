// Generates TypeScript types from schemas/*.schema.json into src/schemas/generated/.
// Usage: npm run schemas:types -w mcp-server            (writes the files)
//        npm run schemas:types -w mcp-server -- --check (fails if any is out of date)
import { readFile, writeFile } from 'node:fs/promises';
import { compile, type JSONSchema } from 'json-schema-to-typescript';

const NAMES = ['config', 'test-ir', 'results', 'selection', 'run-diff'];
const SCHEMAS_DIR = new URL('../../schemas/', import.meta.url);
const OUTPUT_DIR = new URL('../src/schemas/generated/', import.meta.url);

const HEADER = `// Generated from schemas/NAME.schema.json by scripts/generate-schema-types.ts. Do not edit.
// Regenerate with: npm run schemas:types -w mcp-server
`;

async function generate(name: string): Promise<string> {
  const schema = JSON.parse(
    await readFile(new URL(`${name}.schema.json`, SCHEMAS_DIR), 'utf8'),
  ) as JSONSchema;
  const ts = await compile(schema, name, {
    bannerComment: HEADER.replace('NAME', name),
    additionalProperties: false,
    strictIndexSignatures: true,
    unreachableDefinitions: false,
    format: false,
  });
  return ts.endsWith('\n') ? ts : `${ts}\n`;
}

const check = process.argv.includes('--check');
let stale = false;
for (const name of NAMES) {
  const output = await generate(name);
  const file = new URL(`${name}.ts`, OUTPUT_DIR);
  if (check) {
    const current = await readFile(file, 'utf8').catch(() => '');
    if (current !== output) {
      console.error(`generated/${name}.ts is out of date.`);
      stale = true;
    }
  } else {
    await writeFile(file, output);
  }
}
if (stale) {
  console.error('Run: npm run schemas:types -w mcp-server');
  process.exitCode = 1;
} else if (!check) {
  console.log(`Wrote ${String(NAMES.length)} files to src/schemas/generated/`);
}
