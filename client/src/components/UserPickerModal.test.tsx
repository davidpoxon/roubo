// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UserPickerModal from "./UserPickerModal";
import type { UserConfig } from "@roubo/shared";

const users: UserConfig[] = [
  { name: "Alice", properties: { email: "alice@example.com", role: "admin" } },
  { name: "Bob", properties: { email: "bob@example.com" } },
];

describe("UserPickerModal", () => {
  it("does not render when closed", () => {
    render(<UserPickerModal isOpen={false} onClose={vi.fn()} onSelect={vi.fn()} users={users} />);
    expect(screen.queryByText("Select a user")).not.toBeInTheDocument();
  });

  it("renders heading when open", () => {
    render(<UserPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} users={users} />);
    expect(screen.getByText("Select a user")).toBeInTheDocument();
  });

  it("renders user names and first property value", () => {
    render(<UserPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} users={users} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("does not render skip option", () => {
    render(<UserPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} users={users} />);
    expect(screen.queryByText("No login / Skip")).not.toBeInTheDocument();
  });

  it("calls onSelect with userName when a user is clicked", async () => {
    const onSelect = vi.fn();
    render(<UserPickerModal isOpen onClose={vi.fn()} onSelect={onSelect} users={users} />);
    await userEvent.click(screen.getByText("Alice"));
    expect(onSelect).toHaveBeenCalledWith("Alice");
  });

  it("calls onClose when overlay is dismissed", async () => {
    const onClose = vi.fn();
    render(<UserPickerModal isOpen onClose={onClose} onSelect={vi.fn()} users={users} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not show secondary detail when properties is empty", () => {
    const usersNoProps: UserConfig[] = [{ name: "Charlie", properties: {} }];
    render(<UserPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} users={usersNoProps} />);
    expect(screen.getByText("Charlie")).toBeInTheDocument();
  });
});
