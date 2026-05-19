import { TextField, Input, Button } from "react-aria-components";
import { Plus, Trash2, X } from "lucide-react";
import type { UserConfig } from "@roubo/shared";
import type { WizardAction } from "./wizardReducer";
import { INPUT } from "./styles";

interface Props {
  users: UserConfig[];
  currentSubStep: string | null;
  dispatch: React.Dispatch<WizardAction>;
  onAddUser: () => void;
}

export default function SectionUsers({ users, currentSubStep, dispatch, onAddUser }: Props) {
  const updateUser = (index: number, changes: Partial<UserConfig>) => {
    const updated = users.map((u, i) => (i === index ? { ...u, ...changes } : u));
    dispatch({ type: "SET_USERS", payload: updated });
  };

  const removeUser = (index: number) => {
    const remaining = users.filter((_, i) => i !== index);
    dispatch({ type: "SET_USERS", payload: remaining });
    const nextSubStep =
      remaining.length > 0 ? `user-${Math.min(index, remaining.length - 1)}` : null;
    dispatch({ type: "SET_SUB_STEP", payload: nextSubStep });
  };

  const addProperty = (index: number) => {
    const user = users[index];
    updateUser(index, { properties: { ...user.properties, "": "" } });
  };

  const renameKey = (index: number, oldKey: string, newKey: string) => {
    const user = users[index];
    const properties = { ...user.properties };
    const value = properties[oldKey];
    Reflect.deleteProperty(properties, oldKey);
    properties[newKey] = value;
    updateUser(index, { properties });
  };

  const updateValue = (index: number, key: string, value: string) => {
    const user = users[index];
    updateUser(index, { properties: { ...user.properties, [key]: value } });
  };

  const removeProperty = (index: number, key: string) => {
    const user = users[index];
    const properties = { ...user.properties };
    Reflect.deleteProperty(properties, key);
    updateUser(index, { properties });
  };

  // Single user editor view
  if (currentSubStep !== null) {
    const match = currentSubStep.match(/^user-(\d+)$/);
    const index = match ? parseInt(match[1], 10) : -1;
    const user = index >= 0 ? users[index] : undefined;

    if (user !== undefined) {
      return renderUserEditor(user, index);
    }
  }

  // Overview: list of all users
  return (
    <div className="space-y-4">
      {users.length === 0 && (
        <p className="text-sm text-stone-500 dark:text-stone-600 py-4">
          No users configured. This section is optional.
        </p>
      )}

      {users.map((user, i) => (
        <Button
          key={i}
          onPress={() => dispatch({ type: "SET_SUB_STEP", payload: `user-${i}` })}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-stone-100 dark:bg-stone-900/50 hover:bg-stone-200/60 dark:hover:bg-stone-800/60 transition-colors"
        >
          <span className="flex-1 text-sm font-medium text-stone-700 dark:text-stone-300 truncate">
            {user.name || "Untitled"}
          </span>
          <span className="text-[11px] text-stone-400 dark:text-stone-600">
            {Object.keys(user.properties).length}{" "}
            {Object.keys(user.properties).length === 1 ? "property" : "properties"}
          </span>
        </Button>
      ))}

      <Button
        onPress={onAddUser}
        className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none"
      >
        <Plus size={12} /> Add user
      </Button>
    </div>
  );

  function renderUserEditor(user: UserConfig, i: number) {
    const rawEntries = Object.entries(user.properties);
    const entries = rawEntries.length > 0 ? rawEntries : [["", ""] as [string, string]];

    return (
      <div className="space-y-4">
        <div className="space-y-3 rounded-lg bg-stone-100 dark:bg-stone-900/50 px-3 py-3">
          <div className="flex items-center gap-2">
            <TextField
              value={user.name}
              onChange={(v) => updateUser(i, { name: v })}
              aria-label="User name"
              className="min-w-0 flex-1"
            >
              <Input
                placeholder="User name"
                className="bg-transparent text-sm text-stone-800 dark:text-stone-200 font-medium focus:outline-none border-none min-w-0 w-full"
              />
            </TextField>
            <Button
              onPress={() => removeUser(i)}
              aria-label="Remove user"
              className="p-1 text-stone-400 dark:text-stone-600 hover:text-red-400 transition-colors shrink-0 outline-none"
            >
              <Trash2 size={13} />
            </Button>
          </div>

          <fieldset className="space-y-2">
            <legend className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-stone-500 mb-3">
              <span className="size-1.5 rounded-full bg-violet-400/70" />
              Properties
            </legend>
            {entries.map(([key, value], rowIndex) => (
              <div key={rowIndex} className="flex items-center gap-2">
                <TextField
                  value={key}
                  onChange={(v) => renameKey(i, key, v)}
                  aria-label="Property key"
                  isDisabled={rawEntries.length === 0}
                  className="w-1/3"
                >
                  <Input placeholder="key" className={INPUT} />
                </TextField>
                <TextField
                  value={value}
                  onChange={(v) => updateValue(i, key, v)}
                  aria-label="Property value"
                  isDisabled={rawEntries.length === 0}
                  className="flex-1"
                >
                  <Input placeholder="value" className={INPUT} />
                </TextField>
                <Button
                  onPress={() => removeProperty(i, key)}
                  aria-label="Remove property"
                  isDisabled={rawEntries.length === 0}
                  className="p-1 text-stone-400 dark:text-stone-600 hover:text-red-400 transition-colors shrink-0 outline-none disabled:pointer-events-none disabled:opacity-30"
                >
                  <X size={14} />
                </Button>
              </div>
            ))}
            <Button
              onPress={() => addProperty(i)}
              className="flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 transition-colors outline-none"
            >
              <Plus size={12} /> Add property
            </Button>
          </fieldset>
        </div>
      </div>
    );
  }
}
