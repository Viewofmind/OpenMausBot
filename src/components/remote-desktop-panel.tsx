import { useEffect, useState } from "react";
import { ImageOff, Loader2, Monitor, X } from "lucide-react";

import { usePageVisible } from "@/lib/page-visible";
import { api, useStore, type Bot } from "@/state/store";

function viewerAddress(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new Error("The host did not return a live desktop link");
  if (raw.startsWith("/vps-viewer/")) return new URL(raw, window.location.origin).toString();
  return raw;
}

export function remoteScreenshotSource(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as { png?: unknown; format?: unknown };
  if (typeof frame.png !== "string" || !frame.png || !/^[A-Za-z0-9+/=]+$/.test(frame.png)) return null;
  if (frame.format !== "png" && frame.format !== "jpeg") return null;
  return `data:${frame.format === "jpeg" ? "image/jpeg" : "image/png"};base64,${frame.png}`;
}

export function RemoteDesktopPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [previewPending, setPreviewPending] = useState(true);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const pageVisible = usePageVisible();

  useEffect(() => {
    setFrame(null);
    setPreviewPending(true);
    setPreviewUnavailable(false);
  }, [bot.id]);

  useEffect(() => {
    const viewer = window.ogb?.desktopViewer;
    if (!viewer) return;
    let alive = true;
    void viewer.currentState().then((state) => {
      if (alive) setViewerOpen(state.open && state.contextId === bot.id);
    }).catch(() => {});
    const dispose = viewer.onState((state) => {
      if (state.contextId === bot.id || !state.open) setViewerOpen(state.open && state.contextId === bot.id);
    });
    return () => {
      alive = false;
      dispose();
    };
  }, [bot.id]);

  useEffect(() => {
    if (!pageVisible || viewerOpen) return;
    let alive = true;
    let requestRunning = false;
    const shoot = async () => {
      if (requestRunning) return;
      requestRunning = true;
      try {
        const source = remoteScreenshotSource(await api(`/api/bots/${bot.id}/computer/screenshot`, {
          method: "POST",
          body: "{}",
        }));
        if (alive && source) {
          setFrame(source);
          setPreviewUnavailable(false);
        } else if (alive) {
          setPreviewUnavailable(true);
        }
      } catch {
        if (alive) setPreviewUnavailable(true);
      } finally {
        if (alive) setPreviewPending(false);
        requestRunning = false;
      }
    };
    void shoot();
    const timer = window.setInterval(shoot, bot.busy ? 4_000 : 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bot.busy, bot.id, pageVisible, viewerOpen]);

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

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <button
          type="button"
          onClick={() => void open()}
          disabled={pending || !frame}
          className="group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-hairline bg-black disabled:cursor-default"
          aria-label={frame ? `Open ${bot.name}'s live desktop` : "VPS preview unavailable"}
        >
          {frame ? (
            <img src={frame} alt={`${bot.name}'s VPS desktop preview`} className="h-full w-full object-contain" />
          ) : previewPending ? (
            <Loader2 size={22} className="animate-spin text-ink-secondary" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-ink-secondary">
              <ImageOff size={24} />
              <span className="text-[11px]">{previewUnavailable ? "Preview unavailable" : "Waiting for preview"}</span>
            </div>
          )}
          {frame && (
            <span className="absolute inset-x-0 bottom-0 bg-black/65 py-2 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
              Open live desktop
            </span>
          )}
        </button>
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
