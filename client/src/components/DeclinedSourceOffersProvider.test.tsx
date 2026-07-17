// @vitest-environment jsdom
//
// In-memory per-session decline memory (CPHMTP-FR-007, issue #565). These cover
// the store's contract directly: a decline is remembered for the session
// (CPHMTP-TC-078), scoped to the exact project+URL, and a fresh provider mount
// (a new session) starts empty so the offer re-appears (CPHMTP-TC-087).

import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { DeclinedSourceOffersProvider } from "./DeclinedSourceOffersProvider";
import { useDeclinedSourceOffers } from "../hooks/useDeclinedSourceOffers";

const URL_A = "https://marketplace.acme.example/catalog.json";
const URL_B = "https://plugins.other.example/catalog.json";

function wrapper({ children }: { children: ReactNode }) {
  return <DeclinedSourceOffersProvider>{children}</DeclinedSourceOffersProvider>;
}

describe("DeclinedSourceOffersProvider", () => {
  it("starts with nothing declined", () => {
    const { result } = renderHook(() => useDeclinedSourceOffers(), { wrapper });
    expect(result.current.isDeclined("acme-webapp", URL_A)).toBe(false);
  });

  it("remembers a decline for the rest of the session (CPHMTP-TC-078)", () => {
    const { result } = renderHook(() => useDeclinedSourceOffers(), { wrapper });
    act(() => result.current.decline("acme-webapp", URL_A));
    expect(result.current.isDeclined("acme-webapp", URL_A)).toBe(true);
  });

  it("scopes the decline to the exact project and URL", () => {
    const { result } = renderHook(() => useDeclinedSourceOffers(), { wrapper });
    act(() => result.current.decline("acme-webapp", URL_A));
    // Same project, different URL: not declined.
    expect(result.current.isDeclined("acme-webapp", URL_B)).toBe(false);
    // Same URL, different project: not declined.
    expect(result.current.isDeclined("other-project", URL_A)).toBe(false);
  });

  it("is idempotent: declining twice keeps it declined", () => {
    const { result } = renderHook(() => useDeclinedSourceOffers(), { wrapper });
    act(() => result.current.decline("acme-webapp", URL_A));
    act(() => result.current.decline("acme-webapp", URL_A));
    expect(result.current.isDeclined("acme-webapp", URL_A)).toBe(true);
  });

  it("resets on a fresh provider mount, so a new session re-offers (CPHMTP-TC-087)", () => {
    const first = renderHook(() => useDeclinedSourceOffers(), { wrapper });
    act(() => first.result.current.decline("acme-webapp", URL_A));
    expect(first.result.current.isDeclined("acme-webapp", URL_A)).toBe(true);
    first.unmount();

    // A brand-new provider stands in for a fresh app launch: the in-memory Set is
    // gone, so nothing is remembered as declined.
    const second = renderHook(() => useDeclinedSourceOffers(), { wrapper });
    expect(second.result.current.isDeclined("acme-webapp", URL_A)).toBe(false);
  });

  it("throws when used outside its provider", () => {
    expect(() => renderHook(() => useDeclinedSourceOffers())).toThrow(
      /must be used within DeclinedSourceOffersProvider/,
    );
  });
});
