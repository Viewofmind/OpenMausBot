import { useState } from "react";
import { Bell, ChevronLeft, X } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { VoiceSettings } from "./VoiceSettings";
import { Switch } from "./SettingsPrimitives";

type RemoteProfilePatch = Partial<Pick<Bot, "voice" | "speakReplies" | "notifications">>;

export function RemoteAgentSettingsPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const close = () => dispatch({ type: "toggleSettings", open: false });
  const patch = async (next: RemoteProfilePatch) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result: { bot: Bot } = await api(`/api/bots/${bot.id}/profile`, {
        method: "PATCH",
        body: JSON.stringify(next),
      });
      dispatch({ type: "botPatched", bot: result.bot });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this agent.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="animate-panel-in relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={close}
          aria-label="Collapse remote agent settings"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Remote agent settings</span>
        <button
          onClick={close}
          aria-label="Close remote agent settings"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          <VoiceSettings
            bot={bot}
            workspaceConfigurationLocked
            onPatch={(next) => void patch(next)}
          />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div className="flex min-w-0 items-start gap-3">
              <Bell size={16} className="mt-0.5 shrink-0 text-ink-secondary" />
              <div>
                <div className="text-[15px] font-medium text-ink">Notifications</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                  Notify this client when the agent finishes or needs input.
                </div>
              </div>
            </div>
            <Switch
              checked={bot.notifications}
              disabled={saving}
              aria-label="Agent notifications"
              onClick={() => void patch({ notifications: !bot.notifications })}
            />
          </div>

          {error ? <div role="alert" className="text-[12px] text-danger">{error}</div> : null}
        </div>
      </div>
    </aside>
  );
}
