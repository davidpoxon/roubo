import { useMemo, useState } from "react";
import { Button } from "react-aria-components";
import { ShieldAlert } from "lucide-react";
import { FIRST_PARTY_SOURCE_ID, normalizeSourceUrl, type RegisteredProject } from "@roubo/shared";
import { ApiError } from "../../lib/api";
import { useMarketplaceSources } from "../../hooks/useMarketplaceSources";
import { useRegisterMarketplaceSource } from "../../hooks/useMarketplace";
import { useDeclinedSourceOffers } from "../../hooks/useDeclinedSourceOffers";
import { useToast } from "../../hooks/useToast";
import MarketplaceSourceConsentModal, {
  type MarketplaceSourceConsentInput,
} from "./MarketplaceSourceConsentModal";

// Project-open registration offer for declared-but-unregistered marketplaces
// (CPHMTP-FR-007 / CPHMTP-NFR-003 / CPHMTP-US-002, issue #565).
//
// The offer is a PURE CLIENT-SIDE comparison of data already loaded: the
// project's `marketplaces[]` (from useProjects) against the registered sources
// (from GET /api/marketplace/sources). Nothing here fetches the declared URL, so
// "no fetch before consent" (CPHMTP-NFR-003) holds by construction: a malicious
// repo cannot trigger a request just by being opened. The only write is the
// existing consent-accepted POST, itself a pure write with no call to the
// candidate URL, reached only after the user acknowledges the consent dialog.
//
// Declaring URLs are matched to registered sources through the shared
// `normalizeSourceUrl` (the same normalisation the server keyed the registration
// on), so a declared URL differing only by scheme/host casing or a trailing slash
// is treated as the same source and shows no duplicate offer (CPHMTP-TC-080).

const STRINGS = {
  lead: (projectName: string) =>
    `${projectName} declares a marketplace that is not registered yet.`,
  body: "Registering it lets this project's benches install the plugins it offers. Roubo will not contact this marketplace until you register it.",
  review: "Review and register…",
  decline: "Not now",
  declinedToast: "Offer declined for this session.",
  registerFailed: "Could not register this marketplace.",
};

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

interface Props {
  projectId: string;
  project: RegisteredProject | undefined;
}

export default function ProjectDeclaredSourceOffer({ projectId, project }: Props) {
  const { data: sourcesData } = useMarketplaceSources();
  const { isDeclined, decline } = useDeclinedSourceOffers();
  const register = useRegisterMarketplaceSource();
  const { addToast } = useToast();
  // The raw declared URL currently under review in the consent dialog, or null
  // when the dialog is closed. Only one dialog is ever open at a time.
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectName = project?.config?.project?.displayName ?? projectId;

  // Already-registered third-party source hrefs. The built-in first-party source
  // is excluded: the offer is about registering third-party marketplaces, and the
  // first-party catalog is not a registrable third-party source.
  const registeredHrefs = useMemo(() => {
    const set = new Set<string>();
    for (const source of sourcesData?.sources ?? []) {
      if (source.id === FIRST_PARTY_SOURCE_ID) continue;
      const href = normalizeSourceUrl(source.url);
      if (href) set.add(href);
    }
    return set;
  }, [sourcesData]);

  // One offer per unregistered declared URL, de-duplicated by normalised href so
  // two spellings of the same source never render two banners. The map keeps the
  // raw declared string (shown verbatim in the banner and prefilled into the
  // consent dialog exactly as it will be fetched).
  const offers = useMemo(() => {
    const byHref = new Map<string, string>();
    for (const declaration of project?.config?.marketplaces ?? []) {
      const href = normalizeSourceUrl(declaration.url);
      // A malformed declaration is never offered and never fetched.
      if (!href) continue;
      // Already registered (casing/trailing-slash-insensitive): no offer, no duplicate.
      if (registeredHrefs.has(href)) continue;
      // Declined earlier this session: stays suppressed until the next launch.
      if (isDeclined(projectId, href)) continue;
      if (!byHref.has(href)) byHref.set(href, declaration.url);
    }
    return [...byHref.entries()].map(([href, rawUrl]) => ({ href, rawUrl }));
  }, [project, registeredHrefs, isDeclined, projectId]);

  function handleReview(rawUrl: string) {
    setError(null);
    setActiveUrl(rawUrl);
  }

  function handleDecline(href: string) {
    decline(projectId, href);
    addToast(STRINGS.declinedToast);
  }

  function handleCancel() {
    // Cancelling the dialog is not a decline: the banner stays so the offer can be
    // reviewed again. Declining is only ever "Not now".
    setActiveUrl(null);
    setError(null);
  }

  function handleConfirm(input: MarketplaceSourceConsentInput) {
    register.mutate(
      { url: input.url, credential: input.credential, allowHttp: input.allowHttp },
      {
        onSuccess: () => {
          // The mutation invalidates the sources query, so the newly registered
          // URL joins registeredHrefs and its banner drops on the next render.
          setActiveUrl(null);
          setError(null);
        },
        onError: (err) => setError(errorMessage(err, STRINGS.registerFailed)),
      },
    );
  }

  if (offers.length === 0) return null;

  return (
    <>
      {offers.map(({ href, rawUrl }) => (
        <div
          key={href}
          role="status"
          aria-label={`Register the marketplace declared by ${projectName}`}
          data-testid="declared-source-offer"
          data-declared-url={rawUrl}
          className="flex items-start gap-3 border-b border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-4 py-2.5 text-amber-900 dark:text-amber-200"
        >
          <ShieldAlert
            size={16}
            className="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-relaxed">{STRINGS.lead(projectName)}</p>
            <p className="mt-1 font-mono text-[12px] break-all text-amber-800 dark:text-amber-300">
              {rawUrl}
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-amber-800 dark:text-amber-300">
              {STRINGS.body}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                onPress={() => handleReview(rawUrl)}
                data-testid="declared-source-offer-review"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-stone-950 bg-amber-500 hover:bg-amber-400 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                {STRINGS.review}
              </Button>
              <Button
                onPress={() => handleDecline(href)}
                data-testid="declared-source-offer-decline"
                className="px-3 py-1.5 text-xs font-medium rounded-md text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                {STRINGS.decline}
              </Button>
            </div>
          </div>
        </div>
      ))}

      {activeUrl !== null && (
        <MarketplaceSourceConsentModal
          initialUrl={activeUrl}
          error={error}
          isPending={register.isPending}
          onCancel={handleCancel}
          onConfirm={handleConfirm}
        />
      )}
    </>
  );
}
