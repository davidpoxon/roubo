import { useMemo } from "react";
import { RouboConfigSchema, zodIssuesToFieldMap } from "@roubo/shared";
import type { RouboConfig } from "@roubo/shared";

export function useConfigValidation(config: Partial<RouboConfig>): {
  fieldErrors: Record<string, string>;
  isClean: boolean;
} {
  return useMemo(() => {
    const result = RouboConfigSchema.safeParse(config);
    if (result.success) return { fieldErrors: {}, isClean: true };
    return {
      fieldErrors: zodIssuesToFieldMap(result.error.issues),
      isClean: false,
    };
  }, [config]);
}
