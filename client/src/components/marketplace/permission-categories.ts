import { Container, FolderOpen, Globe, KeyRound, Network, TerminalSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PermissionCategory, PluginPermissions } from "@roubo/shared";

// The icon / label / plain-language description for each declared permission
// category, shared so the install consent modal (MarketplaceConsentModal) and
// the marketplace detail drawer (MarketplaceDrawer) render the SAME labels,
// descriptions, and icons for a plugin's declared access (issue #401,
// CP-TC-080 / CP-TC-104). `describe` takes the plugin's full PluginPermissions
// so it can name the specific hosts / slots / paths / executables / ports the
// plugin requests. Pair this with `declaredCategories(permissions)` from
// `@roubo/shared`, which lists exactly the categories a manifest actually
// declares (so no undeclared category is rendered).

export interface CategoryMeta {
  label: string;
  icon: LucideIcon;
  describe: (permissions: PluginPermissions) => string;
}

function joinList(items: readonly string[]): string {
  return items.join(", ");
}

export const CATEGORY_META: Record<PermissionCategory, CategoryMeta> = {
  network: {
    label: "Network access",
    icon: Globe,
    describe: (p) =>
      p.network.hosts.length > 0
        ? `Reach external hosts: ${joinList(p.network.hosts)}.`
        : "Reach external hosts.",
  },
  credentials: {
    label: "Stored credentials",
    icon: KeyRound,
    describe: (p) =>
      p.credentials.slots.length > 0
        ? `Access stored credentials: ${joinList(p.credentials.slots.map((s) => s.slot))}.`
        : "Access your stored credentials.",
  },
  filesystem: {
    label: "Filesystem",
    icon: FolderOpen,
    describe: (p) =>
      p.filesystem.paths.length > 0
        ? `Read files at: ${joinList(p.filesystem.paths)}.`
        : "Read files in the workspace.",
  },
  processes: {
    label: "Run processes",
    icon: TerminalSquare,
    describe: (p) =>
      p.processes !== false && p.processes.executables.length > 0
        ? `Run executables: ${joinList(p.processes.executables)}.`
        : "Run processes on your machine.",
  },
  ports: {
    label: "Network ports",
    icon: Network,
    describe: (p) =>
      p.ports !== undefined && p.ports !== false && p.ports.names.length > 0
        ? `Allocate bench ports: ${joinList(p.ports.names)}.`
        : "Allocate bench ports.",
  },
  docker: {
    label: "Docker",
    icon: Container,
    describe: () => "Manage Docker containers via the host broker.",
  },
};
