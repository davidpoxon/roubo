// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Tile from "./Tile";

describe("Tile", () => {
  it("renders title and children", () => {
    render(
      <Tile icon={<span>icon</span>} title="Project setup">
        <p>body content</p>
      </Tile>,
    );
    expect(screen.getByText("Project setup")).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("exposes region landmark with title as label by default", () => {
    render(
      <Tile icon={<span>i</span>} title="My Tile">
        body
      </Tile>,
    );
    expect(screen.getByRole("region", { name: "My Tile" })).toBeInTheDocument();
  });

  it("uses ariaLabel when provided", () => {
    render(
      <Tile icon={<span>i</span>} title="My Tile" ariaLabel="Custom Label">
        body
      </Tile>,
    );
    expect(screen.getByRole("region", { name: "Custom Label" })).toBeInTheDocument();
  });

  it("renders secondary content when provided", () => {
    render(
      <Tile icon={<span>i</span>} title="T" secondary={<span>subtitle</span>}>
        body
      </Tile>,
    );
    expect(screen.getByText("subtitle")).toBeInTheDocument();
  });

  it("renders headerAction when provided", () => {
    render(
      <Tile icon={<span>i</span>} title="T" headerAction={<button>action</button>}>
        body
      </Tile>,
    );
    expect(screen.getByRole("button", { name: "action" })).toBeInTheDocument();
  });

  it("forwards data-testid", () => {
    render(
      <Tile icon={<span>i</span>} title="T" data-testid="my-tile">
        body
      </Tile>,
    );
    expect(screen.getByTestId("my-tile")).toBeInTheDocument();
  });

  it("renders icon in the header", () => {
    render(
      <Tile icon={<span data-testid="tile-icon">★</span>} title="T">
        body
      </Tile>,
    );
    expect(screen.getByTestId("tile-icon")).toBeInTheDocument();
  });
});
