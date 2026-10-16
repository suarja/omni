import { scanInventory } from "./inventory";

export type Runtime = Readonly<{
  scanInventory: typeof scanInventory;
}>;

export function createDefaultRuntime(): Runtime {
  return Object.freeze({ scanInventory });
}
