import { z } from "zod";

// Issue #558 / CPHMTP-FR-005, CPHMTP-FR-006. Per-plugin marketplace install
// provenance. See:
//   .specifications/component-plugins-hosted-marketplace-third-party/prd.md
//   .specifications/component-plugins-hosted-marketplace-third-party/architecture.md
//     ('Data model': PluginRecord provenance)
//
// A PluginRecord is REBUILT FROM DISK on every load (plugin-manager's
// buildEntryFromDir walks ~/.roubo/plugins and re-parses each manifest), so a
// record field alone cannot remember which marketplace source a plugin was
// installed from: the next rebuild would drop it. This ledger is that memory. It
// is written at commit time with the source the consumer explicitly chose and
// read back when records are rebuilt, so the choice survives restarts.
//
// Structural sibling of plugin-consent-state.ts / marketplace-sources-state.ts:
// its own file under ~/.roubo rather than a widened enable/consent schema, so the
// provenance ledger stays separate from the consent ledger.
//
// Absent entry means first-party / verified, so records predating this file need
// no migration (the fields are additive and optional on PluginRecord).

export const PLUGIN_PROVENANCE_STATE_SCHEMA_VERSION = 1 as const;

export const PluginProvenanceRecordSchema = z
  .object({
    pluginId: z.string().min(1),
    /** The marketplace source id the consumer chose (`first-party` or a registered slug). */
    sourceId: z.string().min(1),
    /** That source's catalog URL, kept so the record reads standalone after the row is removed. */
    sourceUrl: z.string().min(1),
    /**
     * True when the chosen source is unsigned (any third-party source): its trust
     * treatment is "unverified" (CPHMTP-FR-006). Only the first-party signed chain
     * can assert verification, so this is derived from the chosen source at install
     * time and never read off the (unsigned, unverifiable) third-party payload.
     */
    unverified: z.boolean(),
    /**
     * True once the source this plugin came from has been removed from the
     * registry (issue #560 / CPHMTP-FR-009). Stamped at removal time and
     * persisted, never recomputed at read time by joining against the source
     * registry. Optional so rows written before this field stay valid under the
     * strict schema: absent means "not orphaned", so no migration is required.
     */
    orphaned: z.boolean().optional(),
    installedAt: z.string().min(1),
  })
  .strict();
export type PluginProvenanceRecord = z.infer<typeof PluginProvenanceRecordSchema>;

export const PluginProvenanceStateSchema = z
  .object({
    schemaVersion: z.literal(PLUGIN_PROVENANCE_STATE_SCHEMA_VERSION),
    plugins: z.record(z.string().min(1), PluginProvenanceRecordSchema),
  })
  .strict();
export type PluginProvenanceState = z.infer<typeof PluginProvenanceStateSchema>;
