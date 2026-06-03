import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "react-aria-components";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  /**
   * Optional label for the area being guarded (e.g. "settings"). Used in the
   * fallback copy so the user knows what failed without exposing internals.
   */
  area?: string;
  /**
   * Re-render key. When it changes, the boundary resets its error state so a
   * recovered route can render again without a full reload. Pass a value that
   * changes on navigation (e.g. the current pathname).
   */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in its subtree and shows a recoverable panel
 * instead of letting React unmount the whole tree. Without this, any thrown
 * render error blanks the entire window (white screen) and the desktop app
 * appears frozen, forcing a force-quit. A class component is required because
 * only class components support getDerivedStateFromError / componentDidCatch.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props): void {
    // Reset on navigation so a fixed/other route can render after a failure.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console so it is captured in logs / DevTools for triage.
    console.error("Roubo render error caught by ErrorBoundary:", error, info.componentStack);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const area = this.props.area ? ` in ${this.props.area}` : "";

    return (
      <div
        role="alert"
        data-testid="error-boundary-fallback"
        className="flex h-full w-full items-center justify-center p-8"
      >
        <div className="max-w-md w-full rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/40 p-6 shadow-sm">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="flex items-center justify-center w-7 h-7 rounded-md bg-amber-500/20 text-amber-500 dark:text-amber-400 shrink-0">
              <AlertTriangle size={15} aria-hidden />
            </div>
            <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Something went wrong{area}
            </h2>
          </div>

          <p className="text-[13px] text-stone-500 dark:text-stone-400 leading-relaxed mb-4">
            This view hit an unexpected error and could not finish rendering. Your work and other
            views are unaffected. Reload to recover, and if it keeps happening please share the
            details below.
          </p>

          <pre className="text-[11px] font-mono text-stone-500 dark:text-stone-400 bg-stone-100 dark:bg-stone-800/60 rounded-lg p-3 mb-4 overflow-auto max-h-32 whitespace-pre-wrap break-words">
            {error.message || String(error)}
          </pre>

          <div className="flex justify-end">
            <Button
              onPress={this.handleReload}
              className="px-4 py-2 text-[13px] font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-amber-400"
            >
              Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
