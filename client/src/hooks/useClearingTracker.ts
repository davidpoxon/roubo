import { useContext } from "react";
import { TeardownTrackerContext } from "../lib/teardown-tracker-context";

export function useTeardownTracker() {
  const context = useContext(TeardownTrackerContext);
  if (!context) throw new Error("useTeardownTracker must be used within TeardownTrackerProvider");
  return context;
}
