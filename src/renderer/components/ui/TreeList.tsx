import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { IconButton } from "./IconButton";
import { ItemList, ListItem } from "./ItemList";

type TreeItem = Readonly<{
  badges?: ReactNode;
  className?: string;
  dataTestId?: string;
  dim?: boolean;
  leading?: ReactNode;
  name: ReactNode;
  side?: ReactNode;
  sub?: ReactNode;
  variant?: "default" | "dashed";
}>;

export type TreeNode = Readonly<{
  id: string;
  item: TreeItem;
  children?: readonly TreeNode[];
}>;

type VisibleNode = Readonly<{
  depth: number;
  node: TreeNode;
  parentId?: string;
}>;

function collectExpanded(nodes: readonly TreeNode[], depth: number, maxDepth: number, expanded: Set<string>): void {
  for (const node of nodes) {
    if (node.children?.length && depth < maxDepth) expanded.add(node.id);
    if (node.children) collectExpanded(node.children, depth + 1, maxDepth, expanded);
  }
}

function flattenNodes(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentId?: string,
): VisibleNode[] {
  return nodes.flatMap((node) => [
    { node, depth, parentId },
    ...(node.children && expanded.has(node.id) ? flattenNodes(node.children, expanded, depth + 1, node.id) : []),
  ]);
}

function findParent(nodes: readonly TreeNode[], childId: string, parentId?: string): string | undefined {
  for (const node of nodes) {
    if (node.children?.some((child) => child.id === childId)) return node.id;
    const nested = node.children && findParent(node.children, childId, node.id);
    if (nested) return nested;
  }
  return parentId;
}

export function TreeList({
  defaultExpandedDepth = 0,
  nodes,
  onSelect,
  selectedId,
}: Readonly<{
  defaultExpandedDepth?: number;
  nodes: readonly TreeNode[];
  onSelect: (id: string) => void;
  selectedId?: string | null;
}>): ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    collectExpanded(nodes, 0, defaultExpandedDepth, initial);
    return initial;
  });
  const visible = useMemo(() => flattenNodes(nodes, expanded), [expanded, nodes]);

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, index: number, visibleNode: VisibleNode): void => {
    const { node } = visibleNode;
    if (event.key === "ArrowDown" && visible[index + 1]) {
      event.preventDefault();
      onSelect(visible[index + 1].node.id);
      return;
    }
    if (event.key === "ArrowUp" && visible[index - 1]) {
      event.preventDefault();
      onSelect(visible[index - 1].node.id);
      return;
    }
    if (event.key === "ArrowRight" && node.children?.length) {
      event.preventDefault();
      if (!expanded.has(node.id)) toggle(node.id);
      else onSelect(node.children[0].id);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.children?.length && expanded.has(node.id)) toggle(node.id);
      else {
        const parentId = findParent(nodes, node.id);
        if (parentId) onSelect(parentId);
      }
    }
  };

  return (
    <ItemList variant="tree">
      {visible.map((visibleNode, index) => {
        const { node, depth } = visibleNode;
        const hasChildren = Boolean(node.children?.length);
        const toggleControl = hasChildren ? (
          <IconButton
            icon="chevron-down"
            label={`${expanded.has(node.id) ? "Collapse" : "Expand"} ${node.id}`}
            onClick={(event) => {
              event.stopPropagation();
              toggle(node.id);
            }}
          />
        ) : (
          <span className="ui-tree-list__toggle-spacer" />
        );
        const itemStyle = { "--tree-depth": depth } as CSSProperties;
        return (
          <div
            data-tree-depth={depth}
            key={node.id}
            onKeyDownCapture={(event) => {
              if (event.target instanceof HTMLButtonElement && event.target.classList.contains("ui-icon-button"))
                return;
              handleKeyDown(event, index, visibleNode);
            }}
            onClick={(event) => {
              if (event.target instanceof HTMLButtonElement) return;
              onSelect(node.id);
            }}
            role="button"
            style={itemStyle}
            tabIndex={0}
          >
            <ListItem
              {...node.item}
              className={["ui-item--clickable", node.item.className].filter(Boolean).join(" ")}
              dataTestId={node.item.dataTestId ?? `tree-item-${node.id}`}
              leading={
                <span className="ui-tree-list__leading">
                  {toggleControl}
                  {node.item.leading}
                </span>
              }
              selected={selectedId === node.id}
            />
          </div>
        );
      })}
    </ItemList>
  );
}
