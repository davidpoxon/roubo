import { Link } from "react-router";
import { useIssueTypes } from "../../hooks/useIssueTypes";
import { useJigs } from "../../hooks/useJigs";
import Spinner from "../Spinner";
import Select from "../Select";

const USE_DEFAULT_VALUE = "";

interface IssueTypeMappingsSectionProps {
  projectId: string;
  draft: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /**
   * When true, the trailing "Changes write to …" footer is suppressed so a
   * parent panel can render a single shared footer alongside other controls
   * that write to the same `roubo.yaml`.
   */
  embedded?: boolean;
}

export function IssueTypeMappingsSection({
  projectId,
  draft,
  onChange,
  embedded = false,
}: IssueTypeMappingsSectionProps) {
  const {
    data: issueTypesData,
    isLoading: isLoadingTypes,
    isError: isTypesError,
  } = useIssueTypes(projectId);
  const { data: jigs } = useJigs(projectId);

  const isLoading = isLoadingTypes;

  const jigItems = [
    { value: USE_DEFAULT_VALUE, label: "Use default" },
    ...(jigs ?? []).map((bp) => ({ value: bp.id, label: bp.name })),
  ];

  const handleRowChange = (typeName: string, jigId: string) => {
    if (jigId === USE_DEFAULT_VALUE) {
      const next = Object.fromEntries(Object.entries(draft).filter(([k]) => k !== typeName));
      onChange(next);
    } else {
      onChange({ ...draft, [typeName]: jigId });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-12 text-text-secondary">
        <Spinner />
        Loading…
      </div>
    );
  }

  if (isTypesError) {
    return (
      <p className="text-12 text-text-secondary leading-relaxed">
        Could not load issue types. Try again in a moment.
      </p>
    );
  }

  if (issueTypesData && !issueTypesData.configured) {
    if (issueTypesData.reason === "not-connected") {
      return (
        <p className="text-12 text-text-secondary leading-relaxed">
          Connect your GitHub account in{" "}
          <Link
            to="/settings#plugins"
            className="text-accent-text hover:text-text-primary underline underline-offset-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Settings → Plugins
          </Link>{" "}
          to load issue types.
        </p>
      );
    }
    if (issueTypesData.reason === "none-defined") {
      return (
        <p className="text-12 text-text-secondary leading-relaxed">
          No issue types are enabled for this repository. Configure them in your GitHub organization
          settings.
        </p>
      );
    }
    const _exhaustive: never = issueTypesData.reason;
    void _exhaustive;
    return null;
  }

  if (!issueTypesData?.configured) {
    return null;
  }

  if (issueTypesData.types.length === 0) {
    return <p className="text-12 text-text-secondary">No issue types defined.</p>;
  }

  return (
    <div>
      <div className="flex flex-col gap-2">
        {issueTypesData.types.map((typeName) => (
          <div key={typeName} className="flex items-center gap-3">
            <div className="flex items-center gap-2 min-w-0 w-32 shrink-0">
              <span className="text-12 font-medium text-text-primary truncate">{typeName}</span>
            </div>
            <Select
              className="flex-1"
              items={jigItems}
              value={draft[typeName] ?? USE_DEFAULT_VALUE}
              onChange={(val) => handleRowChange(typeName, val)}
              placeholder="Use default"
            />
          </div>
        ))}
      </div>
      {!embedded && (
        <p className="text-11 text-text-secondary mt-3 leading-relaxed">
          Changes write to{" "}
          <span className="font-mono text-text-secondary">{"<repo>/.roubo/roubo.yaml"}</span>.
          Commit alongside your other work.
        </p>
      )}
    </div>
  );
}
