import type { ReactElement } from "react";

import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";
import type { Camera } from "./spatial-types";

export function CanvasCameraControls(
  props: Readonly<{
    camera: Camera;
    disabled: boolean;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFit: () => void;
    onRecenter: () => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  return (
    <div aria-label={t("canvas.cameraControls")} className="canvas-camera-controls" data-canvas-control role="group">
      <button aria-label={t("canvas.zoomOut")} disabled={props.disabled} onClick={props.onZoomOut} type="button">
        −
      </button>
      <output aria-label={t("canvas.zoomLevel")}>{Math.round(props.camera.scale * 100)}%</output>
      <button aria-label={t("canvas.zoomIn")} disabled={props.disabled} onClick={props.onZoomIn} type="button">
        +
      </button>
      <span aria-hidden="true" />
      <button aria-label={t("canvas.fit")} disabled={props.disabled} onClick={props.onFit} type="button">
        <Icon name="grid" size={16} />
      </button>
      <button aria-label={t("canvas.recenter")} disabled={props.disabled} onClick={props.onRecenter} type="button">
        <Icon name="target" size={16} />
      </button>
    </div>
  );
}
