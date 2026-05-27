import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import ts from "typescript";

// NFR-025 / TC-155: user-facing copy in integration-plugin components must be
// hoisted into a module-scope STRINGS or LABELS record (see EnablePluginPromptModal
// or docs/plugin-sdk.md for the convention). This scan walks each opted-in file's
// JSX and fails on inline English text or English string literals in user-visible
// attributes. Existing non-integration-plugin components are intentionally not
// covered; expand the opt-in list when new integration-plugin components land.

const OPTED_IN = [
  "client/src/components/EnablePluginPromptModal.tsx",
  "client/src/components/IssueSourceTile.tsx",
  "client/src/components/MissingPluginDialog.tsx",
  "client/src/components/PluginConfigureDialog.tsx",
  "client/src/components/SourcePicker.tsx",
  "client/src/components/SwitchIntegrationDialog.tsx",
  "client/src/components/settings/plugins/ConnectionStatusPill.tsx",
  "client/src/components/settings/plugins/ErroredBanner.tsx",
  "client/src/components/settings/plugins/IncompatibleBanner.tsx",
  "client/src/components/settings/plugins/InstallPluginDialog.tsx",
  "client/src/components/settings/plugins/InvalidBanner.tsx",
  "client/src/components/settings/plugins/PluginCard.tsx",
  "client/src/components/settings/plugins/PluginsTab.tsx",
  "client/src/components/settings/plugins/SourceLabel.tsx",
  "client/src/components/settings/plugins/StatusPill.tsx",
  "client/src/components/settings/plugins/UninstallPluginDialog.tsx",
  "client/src/components/settings/plugins/ViewLogsDialog.tsx",
  "client/src/components/settings/plugins/install-screens.tsx",
] as const;

const USER_VISIBLE_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-placeholder",
  "title",
  "placeholder",
  "alt",
  "label",
  "description",
  "error",
  "errorMessage",
]);

const HAS_ENGLISH_WORD = /[A-Za-z]{2,}/;

interface Violation {
  line: number;
  kind: "jsx-text" | "jsx-child-string" | "jsx-attribute";
  detail: string;
}

function attrName(attr: ts.JsxAttribute): string {
  const name = attr.name;
  if (ts.isIdentifier(name)) return name.text;
  return `${name.namespace.text}-${name.name.text}`;
}

function lineOf(node: ts.Node, file: ts.SourceFile): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function isJsxChild(node: ts.Node): boolean {
  const parent = node.parent;
  return !!parent && (ts.isJsxElement(parent) || ts.isJsxFragment(parent));
}

// Strings inside a `const STRINGS = { ... }` or `const LABELS = { ... }` record
// ARE the keyed copy. Some entries are React.ReactNode (e.g. a fragment that
// interleaves a monospace `<code>` span with surrounding prose). Treat any node
// whose ancestor chain includes such a declaration as exempt.
function isInsideStringsRecord(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      const name = cur.name.text;
      if (name === "STRINGS" || name === "LABELS") return true;
    }
    cur = cur.parent;
  }
  return false;
}

function scan(relPath: string): Violation[] {
  const abs = resolve(process.cwd(), relPath);
  const src = readFileSync(abs, "utf8");
  const file = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (isInsideStringsRecord(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isJsxText(node)) {
      const trimmed = node.text.trim();
      if (trimmed.length > 0 && HAS_ENGLISH_WORD.test(trimmed)) {
        violations.push({
          line: lineOf(node, file),
          kind: "jsx-text",
          detail: trimmed.slice(0, 80),
        });
      }
    } else if (ts.isJsxExpression(node) && isJsxChild(node) && node.expression) {
      const expr = node.expression;
      if (
        (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) &&
        HAS_ENGLISH_WORD.test(expr.text)
      ) {
        violations.push({
          line: lineOf(node, file),
          kind: "jsx-child-string",
          detail: `{${JSON.stringify(expr.text).slice(0, 80)}}`,
        });
      } else if (ts.isTemplateExpression(expr)) {
        const headHasEnglish = HAS_ENGLISH_WORD.test(expr.head.text);
        const spansHaveEnglish = expr.templateSpans.some((s) =>
          HAS_ENGLISH_WORD.test(s.literal.text),
        );
        if (headHasEnglish || spansHaveEnglish) {
          violations.push({
            line: lineOf(node, file),
            kind: "jsx-child-string",
            detail: "inline template literal in JSX child",
          });
        }
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = attrName(node);
      if (USER_VISIBLE_ATTRS.has(name) && node.initializer) {
        const init = node.initializer;
        let literal: string | undefined;
        if (ts.isStringLiteral(init)) {
          literal = init.text;
        } else if (ts.isJsxExpression(init) && init.expression) {
          const e = init.expression;
          if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
            literal = e.text;
          }
        }
        if (literal !== undefined && HAS_ENGLISH_WORD.test(literal)) {
          violations.push({
            line: lineOf(node, file),
            kind: "jsx-attribute",
            detail: `${name}=${JSON.stringify(literal).slice(0, 80)}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return violations;
}

describe("integration-plugins string-key compliance (NFR-025 / TC-155)", () => {
  for (const relPath of OPTED_IN) {
    it(`${relPath} contains no inline English in JSX`, () => {
      const violations = scan(relPath);
      if (violations.length > 0) {
        const formatted = violations
          .map((v) => `  ${relPath}:${v.line} [${v.kind}] ${v.detail}`)
          .join("\n");
        throw new Error(
          `${violations.length} inline-English violation(s). Hoist into a module-scope ` +
            `STRINGS or LABELS record (see docs/plugin-sdk.md, EnablePluginPromptModal.tsx).\n` +
            formatted,
        );
      }
    });
  }
});
