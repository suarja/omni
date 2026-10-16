import { activeWorkshop } from "../../domain/source-roles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createResourceCatalogue, type ResourceSnapshot } from "../../domain/resource-catalogue";
import type { EntryRef, Observation } from "../../domain/project-source-registry";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";

export type OwnedSkillChoice = Readonly<{
  value: string;
  label: string;
  group: string;
  source: SourceSkillRef;
}>;
export type OwnedSkillPackage = Readonly<{ id: string; name: string; relativeRoot: string }>;
export type OwnedSkillArtifact = Readonly<{ id: string; name: string; artifactPath: string }>;

type LoadedSource = Readonly<{ sourceId: string; observation: Observation }>;
type SourceObserver = (sourceId: string, isCurrent: () => boolean) => Promise<Observation | null>;

export function sourcePackagePath(packageRoot: string, artifactPath: string): string | undefined {
  const prefix = packageRoot === "root" || packageRoot === "" ? "" : `${packageRoot}/`;
  if (prefix && !artifactPath.startsWith(prefix)) return undefined;
  const relative = artifactPath.slice(prefix.length);
  if (!relative.endsWith("/SKILL.md")) return undefined;
  const folder = relative.slice(0, -"/SKILL.md".length);
  return folder && folder.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
    ? folder
    : undefined;
}

function choiceValue(source: SourceSkillRef): string {
  return JSON.stringify([source.sourceId, source.packageId, source.artifactPath]);
}

function uniqueSkillSuffix(choice: OwnedSkillChoice, peers: readonly OwnedSkillChoice[]): string {
  const parts = choice.source.artifactPath.split("/");
  for (let length = 1; length <= parts.length; length += 1) {
    const suffix = parts.slice(-length).join("/");
    if (
      !peers.some((peer) => peer !== choice && peer.source.artifactPath.split("/").slice(-length).join("/") === suffix)
    )
      return suffix;
  }
  return choice.source.artifactPath;
}

export function useOwnedSkillChoices(
  snapshot: ResourceSnapshot,
  onObserveSource: SourceObserver | undefined,
  contextKey = "",
) {
  const [sourceId, setSourceId] = useState("");
  const [packageId, setPackageId] = useState("");
  const [skillArtifactId, setSkillArtifactId] = useState("");
  const [selectedValue, setSelectedValue] = useState("");
  const [loadingSourceId, setLoadingSourceId] = useState<string | null>(null);
  const [unavailableSourceId, setUnavailableSourceId] = useState<string | null>(null);
  const [loadedSource, setLoadedSource] = useState<LoadedSource | null>(null);
  const generation = useRef(0);
  const selectedSource = useRef("");
  const observer = useRef(onObserveSource);
  observer.current = onObserveSource;

  const sources = useMemo(
    () =>
      [activeWorkshop(snapshot.registry)].filter(
        (source): source is NonNullable<typeof source> => source !== undefined && source.availability === "available",
      ),
    [snapshot.registry.sources],
  );

  useEffect(() => {
    generation.current += 1;
    selectedSource.current = "";
    setSourceId("");
    setPackageId("");
    setSkillArtifactId("");
    setSelectedValue("");
    setLoadedSource(null);
    setLoadingSourceId(null);
    setUnavailableSourceId(null);
    return () => {
      generation.current += 1;
      selectedSource.current = "";
    };
  }, [contextKey]);

  const localSnapshot = useMemo(() => {
    if (!loadedSource) return snapshot;
    const roots = snapshot.roots.map((root) =>
      root.entry.kind === "source" && root.entry.id === loadedSource.sourceId
        ? { ...root, evidence: { status: "observed" as const, observation: loadedSource.observation } }
        : root,
    );
    return { ...snapshot, roots };
  }, [loadedSource, snapshot]);
  const catalogue = useMemo(() => createResourceCatalogue(localSnapshot), [localSnapshot]);
  const localSources = useMemo(
    () =>
      [activeWorkshop(localSnapshot.registry)].filter(
        (source): source is NonNullable<typeof source> => source !== undefined && source.availability === "available",
      ),
    [localSnapshot.registry.sources],
  );

  const packages = useMemo((): readonly OwnedSkillPackage[] => {
    if (!sourceId) return [];
    const source: EntryRef = { kind: "source", id: sourceId };
    return catalogue
      .browse({ kind: "entry", entry: source })
      .children.filter((record) => record.ref.kind === "package")
      .flatMap((record) => {
        if (record.ref.kind !== "package") return [];
        const relativeRoot = catalogue.inspect(record.ref)?.resource.relativePath;
        return relativeRoot === undefined ? [] : [{ id: record.ref.packageId, name: record.label, relativeRoot }];
      });
  }, [catalogue, sourceId]);

  const skills = useMemo((): readonly OwnedSkillArtifact[] => {
    const selectedPackage = packages.find((item) => item.id === packageId);
    if (!sourceId || !selectedPackage) return [];
    const entry: EntryRef = { kind: "source", id: sourceId };
    return catalogue
      .browse({ kind: "package", entry, packageId: selectedPackage.id })
      .children.filter((record) => record.ref.kind === "artifact" && record.artifactKind === "skill")
      .flatMap((record) => {
        if (record.ref.kind !== "artifact" || !record.relativePath) return [];
        const artifactPath = sourcePackagePath(selectedPackage.relativeRoot, record.relativePath);
        return artifactPath ? [{ id: record.ref.artifactId, name: record.label, artifactPath }] : [];
      });
  }, [catalogue, packageId, packages, sourceId]);

  const choices = useMemo((): readonly OwnedSkillChoice[] => {
    const observedChoices = localSources.flatMap((source) => {
      const sourceEntry: EntryRef = { kind: "source", id: source.ref.id };
      const packages = catalogue
        .browse({ kind: "entry", entry: sourceEntry })
        .children.filter((record) => record.ref.kind === "package")
        .flatMap((record) => {
          if (record.ref.kind !== "package") return [];
          const packageId = record.ref.packageId;
          const packageLabel = record.label;
          const root = catalogue.inspect(record.ref)?.resource.relativePath;
          if (root === undefined) return [];
          const skillRecords = catalogue
            .browse({ kind: "package", entry: sourceEntry, packageId })
            .children.filter((item) => item.ref.kind === "artifact" && item.artifactKind === "skill");
          return skillRecords.flatMap((skill) => {
            if (skill.ref.kind !== "artifact" || !skill.relativePath) return [];
            const artifactPath = sourcePackagePath(root, skill.relativePath);
            if (!artifactPath) return [];
            const sourceSkill = { sourceId: source.ref.id, packageId, artifactPath };
            return [
              {
                value: choiceValue(sourceSkill),
                label: skill.label,
                group: `${source.displayName} · ${packageLabel}`,
                source: sourceSkill,
              },
            ];
          });
        });
      const evidence = localSnapshot.roots.find(
        (root) => root.entry.kind === "source" && root.entry.id === source.ref.id,
      )?.evidence;
      if (evidence?.status === "observed" || (loadedSource?.sourceId === source.ref.id && !packages.length))
        return packages;
      return packages.length ? packages : [];
    });
    return observedChoices.map((choice) => {
      const peers = observedChoices.filter((peer) => peer.group === choice.group && peer.label === choice.label);
      return peers.length > 1 ? { ...choice, label: `${choice.label} · ${uniqueSkillSuffix(choice, peers)}` } : choice;
    });
  }, [catalogue, loadedSource?.sourceId, localSnapshot.roots, localSources]);

  const loadSource = useCallback(
    async (nextSourceId: string): Promise<void> => {
      const source = sources.find((candidate) => candidate.ref.id === nextSourceId);
      if (!source) return;
      const evidence = snapshot.roots.find(
        (root) => root.entry.kind === "source" && root.entry.id === nextSourceId,
      )?.evidence;
      const nextGeneration = ++generation.current;
      selectedSource.current = nextSourceId;
      setSourceId(nextSourceId);
      setPackageId("");
      setSkillArtifactId("");
      setSelectedValue("");
      setUnavailableSourceId(null);
      if (evidence?.status === "observed") {
        setLoadingSourceId(null);
        return;
      }
      const load = observer.current;
      if (!load) {
        setUnavailableSourceId(nextSourceId);
        setLoadingSourceId(null);
        return;
      }
      setLoadingSourceId(nextSourceId);
      const isCurrent = (): boolean => generation.current === nextGeneration && selectedSource.current === nextSourceId;
      const observation = await load(nextSourceId, isCurrent).catch(() => null);
      if (!isCurrent()) return;
      if (observation) {
        setLoadedSource({ sourceId: nextSourceId, observation });
        setUnavailableSourceId(null);
      } else {
        setUnavailableSourceId(nextSourceId);
      }
      setLoadingSourceId(null);
    },
    [snapshot.roots, sources],
  );

  const selectSource = useCallback(
    (nextSourceId: string): void => {
      setSelectedValue("");
      if (!nextSourceId) {
        generation.current += 1;
        selectedSource.current = "";
        setSourceId("");
        setPackageId("");
        setSkillArtifactId("");
        setLoadingSourceId(null);
        setUnavailableSourceId(null);
        return;
      }
      void loadSource(nextSourceId);
    },
    [loadSource],
  );

  const selectSkill = useCallback(
    (nextSkillId: string): void => {
      const skill = skills.find((candidate) => candidate.id === nextSkillId);
      if (!skill) return;
      setSkillArtifactId(skill.id);
      setSelectedValue(choiceValue({ sourceId, packageId, artifactPath: skill.artifactPath }));
    },
    [packageId, skills, sourceId],
  );

  const selectPackage = useCallback(
    (nextPackageId: string): void => {
      generation.current += 1;
      selectedSource.current = sourceId;
      setPackageId(nextPackageId);
      setSkillArtifactId("");
      setSelectedValue("");
    },
    [sourceId],
  );

  const selectChoice = useCallback(
    (value: string): void => {
      if (!value) {
        setSelectedValue("");
        setSkillArtifactId("");
        return;
      }
      if (value.startsWith("load:")) {
        void loadSource(value.slice("load:".length));
        return;
      }
      const choice = choices.find((candidate) => candidate.value === value);
      if (!choice) return;
      generation.current += 1;
      selectedSource.current = choice.source.sourceId;
      setSourceId(choice.source.sourceId);
      setPackageId(choice.source.packageId);
      const artifact = catalogue
        .browse({
          kind: "package",
          entry: { kind: "source", id: choice.source.sourceId },
          packageId: choice.source.packageId,
        })
        .children.find(
          (record) =>
            record.ref.kind === "artifact" &&
            record.relativePath?.endsWith("/SKILL.md") &&
            sourcePackagePath(
              catalogue.inspect({
                kind: "package",
                entry: { kind: "source", id: choice.source.sourceId },
                packageId: choice.source.packageId,
              })?.resource.relativePath ?? "",
              record.relativePath,
            ) === choice.source.artifactPath,
        );
      setSkillArtifactId(artifact?.ref.kind === "artifact" ? artifact.ref.artifactId : "");
      setSelectedValue(value);
    },
    [catalogue, choices, loadSource],
  );

  const retrySource = useCallback((): void => {
    if (!sourceId) return;
    setUnavailableSourceId(null);
    void loadSource(sourceId);
  }, [loadSource, sourceId]);

  const reset = useCallback((): void => {
    generation.current += 1;
    selectedSource.current = "";
    setSourceId("");
    setPackageId("");
    setSkillArtifactId("");
    setSelectedValue("");
    setLoadedSource(null);
    setLoadingSourceId(null);
    setUnavailableSourceId(null);
  }, []);

  const selected = choices.find((choice) => choice.value === selectedValue);
  const selectedSourceRoot = localSnapshot.roots.find(
    (root) => root.entry.kind === "source" && root.entry.id === sourceId,
  );
  const sourceObservationKey =
    selectedSourceRoot?.evidence.status === "observed"
      ? selectedSourceRoot.evidence.observation.observedAt
      : selectedSourceRoot?.evidence.status;
  const allSourcesEmpty =
    choices.length === 0 &&
    sources.length > 0 &&
    sources.every(
      (source) =>
        localSnapshot.roots.find((root) => root.entry.kind === "source" && root.entry.id === source.ref.id)?.evidence
          .status === "observed",
    );
  const status =
    loadingSourceId === sourceId
      ? "loading"
      : unavailableSourceId === sourceId
        ? "unavailable"
        : sourceId &&
            selectedSourceRoot?.evidence.status === "observed" &&
            (!choices.some((choice) => choice.source.sourceId === sourceId) ||
              (packageId !== "" && skills.length === 0))
          ? "empty"
          : sourceId && packages.length > 0
            ? "ready"
            : allSourcesEmpty
              ? "empty"
              : "idle";
  const options = useMemo(() => {
    const observed = choices;
    const loadOptions = sources.flatMap((source) => {
      const evidence = localSnapshot.roots.find(
        (root) => root.entry.kind === "source" && root.entry.id === source.ref.id,
      )?.evidence;
      if (evidence?.status === "observed") return [];
      return [
        { value: `load:${source.ref.id}`, label: `Load skills from ${source.displayName}`, group: "Personal sources" },
      ];
    });
    return [...observed, ...loadOptions];
  }, [choices, localSnapshot.roots, sources]);

  return {
    choices,
    options,
    packages,
    skills,
    sourceId,
    packageId,
    skillArtifactId,
    selected,
    selectedValue,
    loadingSourceId,
    unavailableSourceId,
    sourceObservationKey,
    status,
    selectChoice,
    selectSource,
    selectPackage,
    selectSkill,
    retrySource,
    reset,
  } as const;
}
