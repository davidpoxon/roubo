import { useState } from "react";
import type { MarketplaceSourceSummary } from "@roubo/shared";
import { ApiError } from "../../../lib/api";
import { useRemoveMarketplaceSource } from "../../../hooks/useMarketplaceSources";
import { useRegisterMarketplaceSource } from "../../../hooks/useMarketplace";
import { usePlugins } from "../../../hooks/usePlugins";
import { useToast } from "../../../hooks/useToast";
import MarketplacesTab from "./MarketplacesTab";
import { sourceDisplayName } from "./marketplace-source-name";
import MarketplaceSourceRemoveDialog from "../../marketplace/MarketplaceSourceRemoveDialog";
import MarketplaceSourceConsentModal, {
  type MarketplaceSourceConsentInput,
} from "../../marketplace/MarketplaceSourceConsentModal";

// Container for the Marketplaces settings section. MarketplacesTab renders the
// list and exposes two seams (issue #561); this container wires both.
//
// Add (CPHMTP-FR-002 / CPHMTP-US-001, issue #609): the onAddSource seam opens the
// registration consent dialog (issue #562) with an empty URL field and owns the
// POST /api/marketplace/sources mutation (useRegisterMarketplaceSource) it drives
// on confirm. Mirrors ProjectDeclaredSourceOffer (issue #565), which mounts the
// same presentational dialog against the same hook (just with a prefilled URL).
// No fetch happens while the dialog is merely open (CPHMTP-NFR-003): the single
// write runs only after the acknowledged Register press, and the hook already
// invalidates the ["marketplace-sources"] settings-list key so the new row
// appears without a manual refresh.
//
// Remove (CPHMTP-FR-009 / CPHMTP-US-006, issue #564): the onRemoveSource seam
// wires the removal consequences dialog and owns the DELETE
// /api/marketplace/sources/:id mutation the dialog drives on confirm.
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
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MarketplaceSourceSummary | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const register = useRegisterMarketplaceSource();
  const remove = useRemoveMarketplaceSource();
  // Full plugin records (not the InstalledPluginSummary shape, which drops
  // `sourceId`), so the affected count can be computed by source of origin.
  const { data: pluginsResponse } = usePlugins();
  const { addToast } = useToast();

  function handleOpenAdd() {
    setAddError(null);
    setAdding(true);
  }

  function handleCancelAdd() {
    if (register.isPending) return;
    setAdding(false);
    setAddError(null);
  }

  function handleConfirmAdd(input: MarketplaceSourceConsentInput) {
    register.mutate(
      { url: input.url, credential: input.credential, allowHttp: input.allowHttp },
      {
        onSuccess: () => {
          // The hook invalidates ["marketplace-sources"], so the new row joins
          // the settings list without a manual refresh (CPHMTP-FR-002).
          setAdding(false);
          setAddError(null);
        },
        // Surface inline in the dialog rather than as a toast: the dialog stays
        // open so the operator can fix the URL and retry (a 400 invalid-url or a
        // 409 already-registered), and the modal keeps the typed input.
        onError: (err) =>
          setAddError(err instanceof ApiError ? err.message : "Failed to add marketplace."),
      },
    );
  }

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
      <MarketplacesTab onAddSource={handleOpenAdd} onRemoveSource={handleOpenRemove} />
      {adding && (
        <MarketplaceSourceConsentModal
          initialUrl=""
          error={addError}
          isPending={register.isPending}
          onCancel={handleCancelAdd}
          onConfirm={handleConfirmAdd}
        />
      )}
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
