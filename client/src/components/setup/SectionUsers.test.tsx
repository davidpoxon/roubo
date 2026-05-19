// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SectionUsers from "./SectionUsers";
import type { UserConfig } from "@roubo/shared";

const baseProps = {
  onAddUser: vi.fn(),
};

describe("SectionUsers", () => {
  describe("overview (no sub-step)", () => {
    it("shows empty state message when there are no users", () => {
      render(<SectionUsers users={[]} {...baseProps} currentSubStep={null} dispatch={vi.fn()} />);
      expect(screen.getByText(/no users configured/i)).toBeInTheDocument();
    });

    it("renders overview cards for each configured user", () => {
      const users: UserConfig[] = [{ name: "Alice", properties: { role: "admin" } }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep={null} dispatch={vi.fn()} />,
      );
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    it("shows Untitled for users with no name", () => {
      const users: UserConfig[] = [{ name: "", properties: {} }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep={null} dispatch={vi.fn()} />,
      );
      expect(screen.getByText("Untitled")).toBeInTheDocument();
    });

    it("calls onAddUser when add user button is clicked", async () => {
      const onAddUser = vi.fn();
      render(
        <SectionUsers
          users={[]}
          {...baseProps}
          onAddUser={onAddUser}
          currentSubStep={null}
          dispatch={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /add user/i }));
      expect(onAddUser).toHaveBeenCalled();
    });

    it("clicking a user overview card dispatches SET_SUB_STEP with the user index key", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [{ name: "Alice", properties: {} }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep={null} dispatch={dispatch} />,
      );
      await userEvent.click(screen.getByRole("button", { name: /alice/i }));
      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SUB_STEP",
        payload: "user-0",
      });
    });
  });

  describe("single user editor (with sub-step)", () => {
    it("renders the user editor for the active sub-step", () => {
      const users: UserConfig[] = [{ name: "Alice", properties: {} }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={vi.fn()} />,
      );
      expect(screen.getByLabelText("User name")).toBeInTheDocument();
    });

    it("dispatches SET_USERS and SET_SUB_STEP(null) when last user is removed", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [{ name: "Alice", properties: {} }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={dispatch} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Remove user" }));
      expect(dispatch).toHaveBeenCalledWith({ type: "SET_USERS", payload: [] });
      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SUB_STEP",
        payload: null,
      });
    });

    it("navigates to the next user when a non-last user is removed", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [
        { name: "Alice", properties: {} },
        { name: "Bob", properties: {} },
      ];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={dispatch} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Remove user" }));
      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SUB_STEP",
        payload: "user-0",
      });
    });

    it("navigates to new last user when the last user of three is removed", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [
        { name: "A", properties: {} },
        { name: "B", properties: {} },
        { name: "C", properties: {} },
      ];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-2" dispatch={dispatch} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Remove user" }));
      // Removed index 2, remaining has 2 items, Math.min(2, 1) = 1
      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SUB_STEP",
        payload: "user-1",
      });
    });

    it("dispatches SET_USERS when user name is changed", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [{ name: "Alice", properties: {} }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={dispatch} />,
      );
      const nameInput = screen.getByLabelText("User name");
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, "Bob");
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_USERS" }));
    });

    it("shows one empty property row when properties is empty", () => {
      const users: UserConfig[] = [{ name: "Alice", properties: {} }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={vi.fn()} />,
      );
      expect(screen.getByLabelText("Property key")).toBeInTheDocument();
      expect(screen.getByLabelText("Property value")).toBeInTheDocument();
    });

    it("disables placeholder row inputs and Remove button when properties is empty", () => {
      const users: UserConfig[] = [{ name: "Alice", properties: {} }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={vi.fn()} />,
      );
      expect(screen.getByLabelText("Property key")).toBeDisabled();
      expect(screen.getByLabelText("Property value")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove property" })).toBeDisabled();
    });

    it("shows all property rows when properties has entries", () => {
      const users: UserConfig[] = [
        {
          name: "Alice",
          properties: { role: "admin", email: "alice@example.com" },
        },
      ];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={vi.fn()} />,
      );
      expect(screen.getAllByLabelText("Property key")).toHaveLength(2);
    });

    it("dispatches SET_USERS with new empty property when Add property is clicked", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [{ name: "Alice", properties: { role: "admin" } }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={dispatch} />,
      );
      await userEvent.click(screen.getByRole("button", { name: /add property/i }));
      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_USERS",
        payload: [{ name: "Alice", properties: { role: "admin", "": "" } }],
      });
    });

    it("dispatches SET_USERS with renamed key when key input is changed", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [{ name: "Alice", properties: { role: "admin" } }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={dispatch} />,
      );
      const keyInput = screen.getByLabelText("Property key");
      await userEvent.tripleClick(keyInput);
      await userEvent.type(keyInput, "x");
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_USERS" }));
    });

    it("dispatches SET_USERS with updated value when value input is changed", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [{ name: "Alice", properties: { role: "admin" } }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={dispatch} />,
      );
      const valueInput = screen.getByLabelText("Property value");
      await userEvent.tripleClick(valueInput);
      await userEvent.type(valueInput, "member");
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_USERS" }));
    });

    it("dispatches SET_USERS with property removed when Remove property button is clicked", async () => {
      const dispatch = vi.fn();
      const users: UserConfig[] = [{ name: "Alice", properties: { role: "admin" } }];
      render(
        <SectionUsers users={users} {...baseProps} currentSubStep="user-0" dispatch={dispatch} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Remove property" }));
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_USERS" }));
    });
  });
});
