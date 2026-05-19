import type { SelectItem } from "./Select";
import FilePathLabel from "./FilePathLabel";

export function filePathItems(paths: string[]): SelectItem[] {
  return paths.map((path) => ({
    value: path,
    label: path,
    renderLabel: <FilePathLabel path={path} className="text-[14px]" />,
  }));
}
