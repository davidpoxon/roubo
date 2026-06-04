import type { PortConfig, ComponentConfig } from "@roubo/shared";

export interface TemplateVariable {
  syntax: string;
  category: "ports" | "urls" | "paths" | "components";
  description: string;
  example: string;
  formula?: string;
}

export interface TemplateVariableContext {
  portNames: string[];
  ports: Record<string, PortConfig>;
  componentNames: string[];
  components: Record<string, ComponentConfig>;
  projectName: string;
}

const CATEGORY_ORDER: TemplateVariable["category"][] = ["ports", "urls", "paths", "components"];

const CATEGORY_LABELS: Record<TemplateVariable["category"], string> = {
  ports: "Ports",
  urls: "URLs",
  paths: "Paths",
  components: "Components",
};

function resolvePortsInTemplate(template: string, ports: Record<string, number>): string {
  return template.replace(/\{\{ports\.([^}]+)\}\}/g, (_, name: string) => {
    const port = ports[name.trim()];
    return port !== undefined ? String(port) : `{{ports.${name}}}`;
  });
}

export function getTemplateVariables(ctx: TemplateVariableContext): TemplateVariable[] {
  const vars: TemplateVariable[] = [];

  // Ports
  for (const name of ctx.portNames) {
    const base = ctx.ports[name]?.base;
    vars.push({
      syntax: `{{ports.${name}}}`,
      category: "ports",
      description: `Allocated port for ${name}`,
      example: base ? String(base) : "–",
      formula: "base + (bench - 1)",
    });
  }

  // URLs
  for (const name of ctx.portNames) {
    const base = ctx.ports[name]?.base;
    const isHttps = ctx.ports[name]?.https ?? false;
    const protocol = isHttps ? "https" : "http";
    vars.push({
      syntax: `{{urls.${name}}}`,
      category: "urls",
      description: `Full URL for ${name} (${protocol})`,
      example: base ? `${protocol}://localhost:${base}` : "–",
    });
  }

  // Paths
  vars.push({
    syntax: "{{workspace}}",
    category: "paths",
    description: "Absolute path to bench's git workspace",
    example: `~/.roubo/workspaces/${ctx.projectName || "…"}/bench-1/`,
  });

  // Components
  for (const name of ctx.componentNames) {
    const componentConfig = ctx.components[name];
    let example = "Not configured";
    if (componentConfig?.connection?.template) {
      const bench1Ports: Record<string, number> = {};
      for (const [pn, pc] of Object.entries(ctx.ports)) {
        bench1Ports[pn] = pc.base;
      }
      example = resolvePortsInTemplate(componentConfig.connection.template, bench1Ports);
    }
    vars.push({
      syntax: `{{components.${name}.connection}}`,
      category: "components",
      description: `Connection string for ${name}`,
      example,
    });
  }

  return vars;
}

export function getGroupedVariables(ctx: TemplateVariableContext) {
  const vars = getTemplateVariables(ctx);
  const groups: {
    category: TemplateVariable["category"];
    label: string;
    items: TemplateVariable[];
  }[] = [];

  for (const cat of CATEGORY_ORDER) {
    const items = vars.filter((v) => v.category === cat);
    if (items.length > 0) {
      groups.push({ category: cat, label: CATEGORY_LABELS[cat], items });
    }
  }

  return groups;
}

export function validateTemplateVariables(value: string, ctx: TemplateVariableContext): string[] {
  if (!value) return [];
  const invalid: string[] = [];
  const pattern = /\{\{([^}]+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const key = match[1].trim();
    if (key === "workspace") continue;
    if (key.startsWith("ports.")) {
      const name = key.slice("ports.".length);
      if (ctx.portNames.includes(name)) continue;
    }
    if (key.startsWith("urls.")) {
      const name = key.slice("urls.".length);
      if (ctx.portNames.includes(name)) continue;
    }
    if (key.startsWith("components.")) {
      const parts = key.split(".");
      if (parts.length === 3 && parts[2] === "connection" && ctx.componentNames.includes(parts[1]))
        continue;
    }
    invalid.push(match[0]);
  }
  return [...new Set(invalid)];
}

export function getBenchExamples(ctx: TemplateVariableContext, benches: number[]) {
  return ctx.portNames.map((name) => {
    const base = ctx.ports[name]?.base ?? 0;
    return {
      name,
      syntax: `{{ports.${name}}}`,
      values: benches.map((b) => base + (b - 1)),
    };
  });
}
