import { useMemo } from "react";
import { Button } from "react-aria-components";
import * as YAML from "yaml";
import { KNOWN_TOP_LEVEL_KEYS } from "./detectExtraFields";

interface Props {
  rawYaml: string;
  onSectionClick?: (key: string, line: number) => void;
}

interface OutlineItem {
  key: string;
  line: number;
  summary: string;
}

function summarize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === "object") return String(Object.keys(value as object).length);
  return String(value);
}

export default function YamlOutlinePanel({ rawYaml, onSectionClick }: Props) {
  const { items, parseError } = useMemo((): {
    items: OutlineItem[];
    parseError: boolean;
  } => {
    if (rawYaml.trim() === "") return { items: [], parseError: false };
    const lineCounter = new YAML.LineCounter();
    let doc: ReturnType<typeof YAML.parseDocument>;
    try {
      doc = YAML.parseDocument(rawYaml, { lineCounter });
    } catch {
      return { items: [], parseError: true };
    }
    if (doc.errors.length > 0 || !YAML.isMap(doc.contents)) {
      return { items: [], parseError: doc.errors.length > 0 };
    }
    const parsed = doc.toJS() as Record<string, unknown>;
    const rawItems: OutlineItem[] = [];
    for (const pair of doc.contents.items) {
      if (!YAML.isPair(pair) || pair.key == null) continue;
      if (!YAML.isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      const range = pair.key.range;
      const line = range ? lineCounter.linePos(range[0]).line : 1;
      rawItems.push({ key, line, summary: summarize(parsed?.[key]) });
    }
    const knownKeys = [...KNOWN_TOP_LEVEL_KEYS].filter((k) => rawItems.some((i) => i.key === k));
    const extraItems = rawItems.filter((i) => !KNOWN_TOP_LEVEL_KEYS.has(i.key));
    const knownItems = knownKeys.flatMap((k) => {
      const item = rawItems.find((i) => i.key === k);
      return item ? [item] : [];
    });
    return { items: [...knownItems, ...extraItems], parseError: false };
  }, [rawYaml]);

  return (
    <div className="rounded-xl border border-border bg-bg-base p-4">
      <div className="text-11 font-semibold uppercase tracking-label text-text-secondary mb-3">
        Outline
      </div>
      {parseError ? (
        <p className="text-11 text-text-secondary italic">
          YAML unreadable: fix errors in the editor
        </p>
      ) : items.length === 0 ? (
        <p className="text-11 text-text-secondary italic">Empty document</p>
      ) : (
        <div className="space-y-1">
          {items.map(({ key, line, summary }) => (
            <Button
              key={key}
              onPress={() => onSectionClick?.(key, line)}
              className="w-full flex items-center justify-between text-12 rounded-control px-1 py-0.5 -mx-1 hover:bg-bg-hover outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring"
            >
              <span className="text-text-body">{key}</span>
              <span className="font-mono text-text-secondary truncate max-w-[10rem] text-right">
                {summary}
              </span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
