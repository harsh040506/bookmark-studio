/**
 * Last line of defence against a render crash.
 *
 * The library lives in IndexedDB, so a component that throws does not destroy any data —
 * but without a boundary React unmounts the whole tree and leaves a blank white page,
 * which is indistinguishable from data loss to the person looking at it. That is the
 * failure this component exists to prevent: it keeps the app's identity on screen, says
 * plainly that the data is intact, and offers the two recoveries that actually work.
 *
 * ## Why a class component
 *
 * `componentDidCatch` and `getDerivedStateFromError` have no hook equivalents. This is
 * the one place in the codebase where a class is the only option.
 *
 * ## Recovery model
 *
 * Two escape routes, in increasing order of severity:
 *   - **Try again** resets the boundary and re-renders. This resolves the common case of
 *     a transient error thrown against a moment's bad state.
 *   - **Reload** restarts the app from persisted storage, which resolves anything the
 *     re-render cannot, because component state is where corruption of this kind lives.
 *
 * Clearing the library is deliberately *not* offered. A render bug is never a reason to
 * destroy somebody's bookmarks, and putting that button next to a scary message is how
 * people lose data to a problem a reload would have fixed.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { retryUnsaved, subscribeWriteHealth, writeHealth } from "@/lib/db";
import { diagnosticsReport, log } from "@/lib/log";

interface Props {
  children: ReactNode;
  /** Optional hook for reporting; called once per caught error. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
  /** Bumped on every reset so children remount rather than resuming bad state. */
  generation: number;
  /** Changes on screen that the device has not stored, so a reload would lose them. */
  unsaved: number;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, generation: 0, unsaved: 0, copied: false };
  private unsubscribe?: () => void;

  componentDidMount(): void {
    this.unsubscribe = subscribeWriteHealth((health) => {
      if (this.state.error) this.setState({ unsaved: health.unsaved });
    });
  }

  componentWillUnmount(): void {
    this.unsubscribe?.();
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console and the local log are the only sinks: this app has no telemetry, by design.
    log.error("ui.render-crash", { error, component: info.componentStack?.split("\n").slice(0, 4).join(" ") });
    this.setState({ unsaved: writeHealth().unsaved });
    this.props.onError?.(error, info);
  }

  private reset = (): void => {
    this.setState((current) => ({ error: null, generation: current.generation + 1 }));
  };

  private reload = (): void => {
    // The unload guard in main.tsx asks first if anything is unsaved.
    window.location.reload();
  };

  private saveAgain = (): void => {
    void retryUnsaved().then(() => this.setState({ unsaved: writeHealth().unsaved }));
  };

  private copyDiagnostics = (): void => {
    const report = diagnosticsReport({ crash: this.state.error });
    void navigator.clipboard
      ?.writeText(report)
      .then(() => this.setState({ copied: true }))
      .catch(() => undefined);
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      // The key forces a fresh subtree on reset; without it React reuses the instances
      // that were mounted when the throw happened, and the same error recurs at once.
      return <div key={this.state.generation} className="contents">{this.props.children}</div>;
    }

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
        <div className="eyebrow">Something broke</div>
        <h1 className="max-w-md font-heading text-[28px] leading-tight text-ink">
          The interface hit an error and stopped rendering
        </h1>
        {this.state.unsaved ? (
          <p className="max-w-md text-base leading-relaxed text-text-2" role="alert">
            {this.state.unsaved === 1 ? "1 recent change has" : `${this.state.unsaved.toLocaleString()} recent changes have`} not
            been saved to this device yet. Save them before reloading, or they will be lost.
          </p>
        ) : (
          <p className="max-w-md text-base leading-relaxed text-text-2">
            Your saved bookmarks are safe in this browser's local database and were not touched.
            Try again, or reload to start from the saved copy.
          </p>
        )}

        <div className="flex flex-wrap justify-center gap-2 pt-1">
          {this.state.unsaved ? <Button onClick={this.saveAgain}>Save changes</Button> : null}
          <Button variant={this.state.unsaved ? "outline" : "default"} onClick={this.reset}>
            Try again
          </Button>
          <Button variant="outline" onClick={this.reload}>
            Reload the app
          </Button>
          <Button variant="ghost" onClick={this.copyDiagnostics}>
            {this.state.copied ? "Copied" : "Copy diagnostics"}
          </Button>
        </div>

        {/* The message is shown rather than hidden: this runs on the user's own machine,
            and a name they can search for beats a shrug. The stack stays collapsed so it
            does not dominate the screen. */}
        <details className="mt-2 max-w-lg text-left">
          <summary className="eyebrow cursor-pointer hover:text-text-2">
            Technical detail
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--pre-bg)] p-3 font-mono text-xs text-[var(--pre-fg)]">
            {error.message}
            {error.stack ? `

${error.stack}` : ""}
          </pre>
        </details>
      </div>
    );
  }
}
