import { createContext } from "react";

export interface TeardownEntry {
  projectId: string;
  benchId: number;
  branch: string;
  registeredAt: number;
}

export interface TeardownTrackerContextValue {
  teardowns: Map<string, TeardownEntry>;
  register: (projectId: string, benchId: number, branch: string) => void;
}

export const TeardownTrackerContext = createContext<TeardownTrackerContextValue | null>(null);
