/**
 * The sidebar's footer: how this copy of the app reaches the web, in one line, plus Import.
 *
 * "Offline" is not an error — import, search, organise and export all work — so it is said
 * plainly in tertiary text with a way to switch the network passes on, never as a warning.
 */
import { Chrome, Import, Plug, Server, Spinner } from "@/components/icons";
import { Hint } from "@/components/ui/tooltip";
import { requestBridgeAccess } from "@/lib/bridge";
import type { RuntimeState } from "@/lib/runtime";
import { cn } from "@/lib/utils";

export function ConnectionStatus({
  runtime,
  busy,
  onOpen,
  onImport,
}: {
  runtime: RuntimeState;
  /** Background items still to process, or 0. */
  busy: number;
  onOpen: () => void;
  onImport: () => void;
}) {
  const { label, icon, tone } = describe(runtime);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm w-full justify-start" onClick={onImport}>
        <Import /> Import bookmarks…
      </button>
      {runtime.extensionNeedsApproval ? (
        <button type="button" className="btn btn-primary btn-sm w-full justify-start" onClick={() => void requestBridgeAccess().catch(() => undefined)}>
          <Plug /> Allow this site in the extension…
        </button>
      ) : null}
      <Hint label="How this app reaches the web — Settings → Connections" side="top">
        <button type="button" className={cn("bs-conn", `is-${tone}`)} onClick={onOpen}>
          <span className="bs-conn-dot" aria-hidden />
          {busy ? <Spinner size={14} className="animate-spin" /> : icon}
          <span className="bs-conn-label">{busy ? `Filling in ${busy.toLocaleString()}…` : label}</span>
        </button>
      </Hint>
    </>
  );
}

function describe(runtime: RuntimeState): { label: string; icon: React.ReactNode; tone: "on" | "off" } {
  switch (runtime.net) {
    case "extension":
      return { label: "Synced with Chrome", icon: <Chrome size={14} />, tone: "on" };
    case "bridge":
      return { label: "Extension connected", icon: <Plug size={14} />, tone: "on" };
    case "server":
      return { label: "Local server connected", icon: <Server size={14} />, tone: "on" };
    default:
      if (runtime.extensionNeedsApproval) return { label: "Extension found · not allowed yet", icon: <Plug size={14} />, tone: "off" };
      return { label: "Offline · connect for previews", icon: <Plug size={14} />, tone: "off" };
  }
}
