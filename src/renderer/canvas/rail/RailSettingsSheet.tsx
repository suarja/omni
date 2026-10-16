import { activeWorkshop } from "../../../domain/source-roles";
import { useEffect, useState, type ReactElement } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import { SettingsSections } from "../../settings/SettingsSections";
import { AiConnectionSection } from "../../settings/AiConnectionSection";
import { AiFunctionSection } from "../../settings/AiFunctionSection";
import type { Route } from "../../navigation";
import { useI18n } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { useCanvasRail } from "./rail-context";

export function RailSettingsSheet(
  props: Readonly<{ onApplyingChange: (active: boolean) => void }>,
): ReactElement | null {
  const rail = useCanvasRail();
  const { t } = useI18n();
  const [route, setRoute] = useState<Route>(rail?.canvas.initialSettingsRoute ?? { screen: "settings" });
  const initialRoute = rail?.canvas.initialSettingsRoute;
  useEffect(() => setRoute(initialRoute ?? { screen: "settings" }), [initialRoute]);
  if (!rail) return null;
  const services = rail.canvas.railServices;
  const api = (services?.api ?? rail.canvas.api) as DesktopApi | null;
  function navigate(next: Route): void {
    if (
      next.screen === "settings" ||
      next.screen === "settings-ai-connection" ||
      next.screen === "settings-ai-function"
    )
      setRoute(next);
    else {
      rail?.close();
      rail?.canvas.onNavigate(next);
    }
  }
  return (
    <SheetFrame
      title={t("canvas.settings")}
      kicker={t("canvas.settings")}
      testId="canvas-settings-sheet"
      busy={false}
      onClose={rail.close}
    >
      {route.screen === "settings-ai-connection" && import.meta.env.DEV ? (
        <AiConnectionSection api={api} onNavigateToRoute={navigate} />
      ) : route.screen === "settings-ai-function" && import.meta.env.DEV ? (
        <AiFunctionSection api={api} task={route.task} onNavigateToRoute={navigate} />
      ) : (
        <SettingsSections
          api={api}
          onAgentApplyingChange={props.onApplyingChange}
          marketplace={(() => {
            const source = activeWorkshop(rail.canvas.snapshot.registry);
            return source ? { name: source.displayName, path: source.displayRoot } : undefined;
          })()}
          onOpenMarketplace={(() => {
            const source = activeWorkshop(rail.canvas.snapshot.registry);
            return source
              ? () => {
                  rail.open("owned-marketplace");
                }
              : undefined;
          })()}
          onNavigateToRoute={navigate}
        />
      )}
    </SheetFrame>
  );
}
