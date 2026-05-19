import RouboLogo from "./RouboLogo";

export default function TitleBar({ projectName }: { projectName?: string }) {
  const isMac = window.roubo?.platform === "darwin";

  return (
    <div className="h-10 shrink-0 flex items-center border-b border-stone-200 dark:border-stone-800/40 bg-stone-50 dark:bg-stone-950/60 drag-region">
      <div className={`flex items-center gap-2.5 ${isMac ? "pl-[92px]" : "pl-5"}`}>
        {projectName ? (
          <h1 className="text-[11px] font-semibold text-stone-700 dark:text-stone-300 truncate">
            {projectName}
          </h1>
        ) : (
          <>
            <RouboLogo className="w-[18px] h-[18px] text-amber-500 shrink-0" />
            <h1 className="text-[11px] font-bold tracking-[0.2em] uppercase text-stone-700 dark:text-stone-300">
              ROUBO
            </h1>
          </>
        )}
      </div>
    </div>
  );
}
