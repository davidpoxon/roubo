import { useState } from "react";
import type { MarketplaceSourceSummary } from "@roubo/shared";
import { ApiError } from "../../../lib/api";
import { useRemoveMarketplaceSource } from "../../../hooks/useMarketplaceSources";
import { usePlugins } from "../../../hooks/usePlugins";
import { useToast } from "../../../hooks/useToast";
import MarketplacesTab from "./MarketplacesTab";
import { sourceDisplayName } from "./marketplace-source-name";
import MarketplaceSourceRemoveDialog from "../../marketplace/MarketplaceSourceRemoveDialog";

// Container for the Marketplaces settings section (CPHMTP-FR-009 / CPHMTP-US-006,
// issue #564). MarketplacesTab renders the list and exposes an onRemoveSource seam
// (issue #561); this container wires that seam to the removal consequences dialog
// and owns the DELETE /api/marketplace/sources/:id mutation the dialog drives on
// confirm.
//
// The backend cascade (registry-row delete, per-source cache delete, keyring
// credential delete, and the orphan stamp on affected plugin records) already
// ships and is tested (issues #553 / #558 / #560); DELETE answers 204 with no
// body. The "N plugin orphaned" figure the confirmation reports is therefore
// derived client-side from the installed plugin records (each carries the
// `sourceId` it was installed from) filtered by the removed source's id, taken
// before the mutation stamps them.

function orphanedPhrase(count: number): string {
  return `${count} ${count === 1 ? "plugin" : "plugins"} orphaned`;
}

export default function MarketplacesTabPanel() {
  const [removing, setRemoving] = useState<MarketplaceSourceSummary | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const remove = useRemoveMarketplaceSource();
  // Full plugin records (not the InstalledPluginSummary shape, which drops
  // `sourceId`), so the affected count can be computed by source of origin.
  const { data: pluginsResponse } = usePlugins();
  const { addToast } = useToast();

  function handleOpenRemove(source: MarketplaceSourceSummary) {
    setRemoveError(null);
    setRemoving(source);
  }

  function handleCancelRemove() {
    if (remove.isPending) return;
    setRemoving(null);
    setRemoveError(null);
  }

  async function handleConfirmRemove() {
    if (!removing) return;
    const source = removing;
    // Count the plugins that will be orphaned BEFORE the mutation stamps them:
    // every record installed from this source becomes orphaned on removal.
    const orphanCount = (pluginsResponse?.plugins ?? []).filter(
      (plugin) => plugin.sourceId === source.id,
    ).length;
    setRemoveError(null);
    try {
      await remove.mutateAsync(source.id);
      setRemoving(null);
      addToast(`Removed ${sourceDisplayName(source)}; ${orphanedPhrase(orphanCount)}`);
    } catch (err) {
      // Surface inline in the dialog rather than as a toast: the dialog stays
      // open so the operator can retry or cancel.
      setRemoveError(err instanceof ApiError ? err.message : "Failed to remove marketplace.");
    }
  }

  return (
    <>
      <MarketplacesTab onRemoveSource={handleOpenRemove} />
      {removing && (
        <MarketplaceSourceRemoveDialog
          sourceName={sourceDisplayName(removing)}
          sourceUrl={removing.url}
          error={removeError}
          isPending={remove.isPending}
          onCancel={handleCancelRemove}
          onConfirm={handleConfirmRemove}
        />
      )}
    </>
  );
}
