import type { ResourceRef } from "../../domain/resource-catalogue";
import type { Destination, Route } from "../navigation";
import { resourceNodeId } from "./spatial/spatial-types";

export function routeForResource(ref: ResourceRef): Route {
  return { screen: "resource-canvas", context: ref };
}

export function focusResourceNode(ref: ResourceRef | undefined, path?: string): void {
  if (!ref) return;
  const id = resourceNodeId(ref, path);
  const rowByLocation = [...document.querySelectorAll<HTMLElement>("[data-node-id]")].find(
    (candidate) => candidate.dataset.nodeId === id,
  );
  if (rowByLocation) {
    rowByLocation.querySelector<HTMLButtonElement>(".canvas-node")?.focus();
    return;
  }
  const key = JSON.stringify(ref);
  const row = [...document.querySelectorAll<HTMLElement>(".canvas-node-row")].find(
    (candidate) => candidate.dataset.nodeKey === key,
  );
  row?.querySelector<HTMLButtonElement>(".canvas-node")?.focus();
}

export function typeIcon(destination: Destination): "home" | "review" | "activity" | "settings" | "more" {
  if (destination === "review") return "review";
  if (destination === "activity") return "activity";
  if (destination === "settings") return "settings";
  return "home";
}
