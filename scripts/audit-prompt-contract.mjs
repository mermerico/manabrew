import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function rustVariantToPromptType(variant) {
  return variant.charAt(0).toLowerCase() + variant.slice(1);
}

function extractRustEnumVariants(enumName) {
  const source = read("forge-engine/crates/forge-agent-interface/src/prompt.rs");
  const variants = [];
  let inEnum = false;
  let depth = 0;
  for (const line of source.split("\n")) {
    if (line.includes(`pub enum ${enumName}`)) {
      inEnum = true;
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      continue;
    }
    if (!inEnum) {
      continue;
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (depth <= 0) {
      break;
    }
    const match = line.match(/^ {4}([A-Z][A-Za-z0-9]*)\s*\{/);
    if (match) {
      variants.push(match[1]);
    }
  }
  return variants;
}

function extractTsPromptTypes() {
  const dir = path.join(root, "src/protocol/prompts");
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts") && entry !== "index.ts")
    .flatMap((entry) => {
      const source = read(path.join("src/protocol/prompts", entry));
      return [...source.matchAll(/^export type Type = "([^"]+)";/gm)].map(([, value]) => ({
        key: value,
        value,
      }));
    })
    .sort((a, b) => a.value.localeCompare(b.value));
}

function extractObjectLiteral(source, constName) {
  const start = source.indexOf(`const ${constName}`);
  if (start < 0) {
    return "";
  }
  const equals = source.indexOf("=", start);
  const open = source.indexOf("{", equals);
  if (open < 0) {
    return "";
  }
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }
  return "";
}

function extractPromptRegistryKeys(relativePath, constName) {
  const source = read(relativePath);
  const registry = extractObjectLiteral(source, constName);
  return new Set([
    ...[...registry.matchAll(/\["([^"]+)"\]\s*:/g)].map(([, key]) => key),
    ...[...registry.matchAll(/^ {2}([a-z][A-Za-z0-9]*)\s*:/gm)].map(([, key]) => key),
  ]);
}

function extractJavaPromptKinds() {
  const source = read("forge-engine/crates/forge-agent-interface/src/java_raw.rs");
  const match = source.match(/fn kind_label\(&self\) -> &'static str \{[\s\S]*?\n {4}\}/);
  if (!match) {
    return [];
  }
  return [...match[0].matchAll(/"([a-z_]+)"/g)].map(([, kind]) => kind).sort();
}

function diff(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

const rustVariants = extractRustEnumVariants("AgentPromptInner");
const rustPromptTypes = rustVariants.map(rustVariantToPromptType);
const tsPromptTypes = extractTsPromptTypes();
const tsKeys = tsPromptTypes.map((entry) => entry.key);
const tsValues = tsPromptTypes.map((entry) => entry.value);
const handlerKeys = [
  ...extractPromptRegistryKeys(
    "src/components/game/prompts/promptHandlers.ts",
    "PROMPT_HANDLER_OVERRIDES",
  ),
];
const modalKeys = [
  ...extractPromptRegistryKeys("src/components/game/prompts/promptComponents.tsx", "PROMPT_MODALS"),
];
const javaKinds = extractJavaPromptKinds();

const missingInTs = diff(rustPromptTypes, tsValues);
const extraInTs = diff(tsValues, rustPromptTypes);
const unknownHandlerKeys = diff(handlerKeys, tsValues);
const unknownModalKeys = diff(modalKeys, tsValues);

console.log("Prompt contract audit");
console.log("=====================");
console.log(`Rust AgentPromptInner variants: ${rustPromptTypes.length}`);
console.log(`TypeScript PromptType values: ${tsValues.length}`);
console.log(`Prompt handler entries: ${handlerKeys.length}`);
console.log(`Prompt modal entries: ${modalKeys.length}`);
console.log(`Java normalizer raw prompt kinds: ${javaKinds.join(", ") || "none"}`);
console.log("");

function printList(title, values) {
  console.log(`${title}: ${values.length === 0 ? "none" : ""}`);
  for (const value of values) {
    console.log(`- ${value}`);
  }
  console.log("");
}

printList("Rust prompt types missing from TypeScript", missingInTs);
printList("TypeScript prompt types missing from Rust", extraInTs);
printList("Prompt handler keys missing from TypeScript", unknownHandlerKeys);
printList("Prompt modal keys missing from TypeScript", unknownModalKeys);

if (
  missingInTs.length > 0 ||
  extraInTs.length > 0 ||
  unknownHandlerKeys.length > 0 ||
  unknownModalKeys.length > 0
) {
  process.exitCode = 1;
}
