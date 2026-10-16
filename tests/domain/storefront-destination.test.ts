import { expect, it } from "vitest";
import { redactStorefrontOrigin, storefrontDestination } from "../../src/domain/storefront-destination";

it("removes URL credentials and token-bearing query and fragment from an origin", () => {
  expect(
    redactStorefrontOrigin("https://user:secret@git.example.com/team/tools.git?token=secret#secret", "/Users/example"),
  ).toBe("https://git.example.com/team/tools.git");
});
it("abbreviates only paths inside the actual home and preserves other destinations", () => {
  expect(redactStorefrontOrigin("/Users/example/remotes/tools.git", "/Users/example")).toBe("~/remotes/tools.git");
  const siblingPath = ["/Users", "example-other", "tools.git"].join("/");
  expect(redactStorefrontOrigin(siblingPath, "/Users/example")).toBe(siblingPath);
  expect(redactStorefrontOrigin("/tmp/tools.git", "/Users/example")).toBe("/tmp/tools.git");
});
it("uses canonical GitHub identity, redacted origin otherwise, and no URL when unread", () => {
  expect(
    storefrontDestination({ githubRepository: "owner/tools", originUrl: "https://github.com/owner/tools.git" }),
  ).toBe("github.com/owner/tools");
  expect(storefrontDestination({ originUrl: "~/remotes/tools.git" })).toBe("~/remotes/tools.git");
  expect(storefrontDestination(undefined)).toBe("");
});
