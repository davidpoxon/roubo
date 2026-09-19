import RouboLogo from "./RouboLogo";

export default function TitleBar({ projectName }: { projectName?: string }) {
  const isMac = window.roubo?.platform === "darwin";

  return (
    <header className="h-10 shrink-0 flex items-center border-b border-border bg-bg-base drag-region">
      <div className={`flex items-center gap-2.5 ${isMac ? "pl-[92px]" : "pl-5"}`}>
        {projectName ? (
          <h1 className="text-11 font-semibold text-text-primary truncate">{projectName}</h1>
        ) : (
          <>
            <RouboLogo className="w-[18px] h-[18px] text-accent shrink-0" />
            <h1 className="text-11 font-bold tracking-[0.2em] uppercase text-text-primary">
              ROUBO
            </h1>
          </>
        )}
      </div>
    </header>
  );
}
