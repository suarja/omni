# Omni Academy

The Academy is the shared, offline-first content set for Omni's Learn destination.
The Markdown files under `content/en` and `content/fr` are the source of truth. The build
script validates their frontmatter and internal links, then writes `academy.json`, the contract
used by the desktop app and the future public `omni-academy` site.

## Build

```sh
pnpm --filter @omni/academy build
```

The package deliberately has no runtime dependencies and does not fetch content. It imports
Omni's existing frontmatter parser and the approved CTA route list while building the snapshot.
