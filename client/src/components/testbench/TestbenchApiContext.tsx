import { createContext, useContext } from "react";
import * as api from "../../lib/api";

// The narrow client context of the TestBench surfaces (SB-FR-026): the writes a
// host of those surfaces can follow up. The TestBench panel uses the default,
// the plain routes. A Spec Bench's gate sitting provides its own, which writes
// through the same routes and then reads the delivery again, so a fix unit a
// Not met mark filed shows on the sitting at once.
export interface TestbenchApi {
  setStatusOverride: typeof api.setStatusOverride;
}

// Each call looks the route up when it runs, so a test that mocks the api
// module after this module loaded still reaches the mock.
export const defaultTestbenchApi: TestbenchApi = {
  setStatusOverride: (...args) => api.setStatusOverride(...args),
};

export const TestbenchApiContext = createContext<TestbenchApi>(defaultTestbenchApi);

export function useTestbenchApi(): TestbenchApi {
  return useContext(TestbenchApiContext);
}
