import { expect, it } from "vitest";
import { parseInventorySnapshot } from "../../src/shared/inventory-dto";
import { resourceFixture } from "../fixtures/resource-catalogue";

it("carries locally declared marketplace visibility through the strict observation boundary", () => {
  const inventory = resourceFixture.sourceObservation.inventory;
  const marketplace = { name: "Personal", manifestPath: "omni.marketplace.json" };
  for (const visibility of ["private", "public"] as const) {
    expect(
      parseInventorySnapshot({ ...inventory, marketplace: { ...marketplace, visibility } }).marketplace?.visibility,
    ).toBe(visibility);
  }
  expect(parseInventorySnapshot({ ...inventory, marketplace }).marketplace).not.toHaveProperty("visibility");
  expect(() =>
    parseInventorySnapshot({ ...inventory, marketplace: { ...marketplace, visibility: "unknown" } }),
  ).toThrow("Marketplace visibility is invalid.");
});
