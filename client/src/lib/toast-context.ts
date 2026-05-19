import { createContext } from "react";

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
  onExpire?: () => void;
}

export interface ToastContextValue {
  addToast: (message: string, options?: ToastOptions) => string;
  removeToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
