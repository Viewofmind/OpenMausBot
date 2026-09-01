import { useState } from "react";
import { Loader2, Monitor, X } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";

function viewerAddress(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new Error("The host did not return a live desktop link");
  if (raw.startsWith("/vps-viewer/")) return new URL(raw, window.location.origin).toString();
  return raw;
}

export function RemoteDesktopPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setPending(true);
    setError(null);
    let tookControl = false;
    try {
      if (!window.ogb?.desktopViewer) throw new Error("The desktop viewer is unavailable in this build");
      await api(`/api/bots/${bot.id}/computer/control`, {
        method: "POST",
        body: JSON.stringify({ action: "take" }),
      });
      tookControl = true;
      const joined = await api(`/api/bots/${bot.id}/computer/join`, {
        method: "POST",
        body: "{}",
      });
      const opened = await window.ogb.desktopViewer.open(
        viewerAddress(joined.joinUrl),
        `${bot.name}'s live desktop`,
        bot.id,
      );
      if (!opened) throw new Error("OpenMausBot could not open the live desktop");
    } catch (cause) {
      if (tookControl) {
        await api(`/api/bots/${bot.id}/computer/control`, {
          method: "POST",
          body: JSON.stringify({ action: "release" }),
        }).catch(() => {});
      }
      await api(`/api/bots/${bot.id}/computer/viewer-close`, {
        method: "POST",
        body: "{}",
      }).catch(() => {});
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline bg-panel">
      <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <div>
          <div className="text-[14px] font-medium text-ink">{bot.name}&apos;s computer</div>
          <div className="mt-0.5 text-[11px] text-ink-secondary">
            {bot.cloudBackend === "vps" ? "Self-hosted VPS" : "Cloud desktop"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          aria-label="Close computer panel"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-control text-ink-secondary">
          <Monitor size={26} />
        </div>
        <div>
          <div className="text-[14px] font-medium text-ink">Open the live desktop</div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
            The host creates a temporary, encrypted viewer relay. VPS SSH and VNC credentials stay on the host computer.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void open()}
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Monitor size={15} />}
          {pending ? "Opening…" : "Take control"}
        </button>
        {error && (
          <div role="alert" className="w-full rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-left text-[12px] text-danger">
            {error}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-ink-tertiary">
          The host must enable cloud desktop access for this paired device in Settings → Phone.
        </p>
      </div>
    </aside>
  );
}
