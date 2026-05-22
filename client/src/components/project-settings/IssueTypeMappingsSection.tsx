import { Link } from "react-router-dom";
import { useIssueTypes } from "../../hooks/useIssueTypes";
import { useBlueprints } from "../../hooks/useBlueprints";
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
  const { data: blueprints } = useBlueprints(projectId);

  const isLoading = isLoadingTypes;

  const blueprintItems = [
    { value: USE_DEFAULT_VALUE, label: "Use default" },
    ...(blueprints ?? []).map((bp) => ({ value: bp.id, label: bp.name })),
  ];

  const handleRowChange = (typeName: string, blueprintId: string) => {
    if (blueprintId === USE_DEFAULT_VALUE) {
      const next = Object.fromEntries(Object.entries(draft).filter(([k]) => k !== typeName));
      onChange(next);
    } else {
      onChange({ ...draft, [typeName]: blueprintId });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
        <Spinner />
        Loading…
      </div>
    );
  }

  if (isTypesError) {
    return (
      <p className="text-xs text-stone-400 dark:text-stone-600 leading-relaxed">
        Could not load issue types. Try again in a moment.
      </p>
    );
  }

  if (issueTypesData && !issueTypesData.configured) {
    if (issueTypesData.reason === "not-connected") {
      return (
        <p className="text-xs text-stone-400 dark:text-stone-600 leading-relaxed">
          Connect your GitHub account in{" "}
          <Link
            to="/settings"
            className="text-amber-500 hover:text-amber-400 underline underline-offset-2 transition-colors"
          >
            Settings → Integrations
          </Link>{" "}
          to load issue types.
        </p>
      );
    }
    if (issueTypesData.reason === "none-defined") {
      return (
        <p className="text-xs text-stone-400 dark:text-stone-600 leading-relaxed">
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
    return <p className="text-xs text-stone-400 dark:text-stone-600">No issue types defined.</p>;
  }

  return (
    <div>
      <div className="flex flex-col gap-2">
        {issueTypesData.types.map((typeName) => (
          <div key={typeName} className="flex items-center gap-3">
            <div className="flex items-center gap-2 min-w-0 w-32 shrink-0">
              <span className="text-xs font-medium text-stone-700 dark:text-stone-300 truncate">
                {typeName}
              </span>
            </div>
            <Select
              className="flex-1"
              items={blueprintItems}
              value={draft[typeName] ?? USE_DEFAULT_VALUE}
              onChange={(val) => handleRowChange(typeName, val)}
              placeholder="Use default"
            />
          </div>
        ))}
      </div>
      {!embedded && (
        <p className="text-[11px] text-stone-400 dark:text-stone-600 mt-3 leading-relaxed">
          Changes write to{" "}
          <span className="font-mono text-stone-500 dark:text-stone-500">
            {"<repo>/.roubo/roubo.yaml"}
          </span>{" "}
          — commit alongside your other work.
        </p>
      )}
    </div>
  );
}
