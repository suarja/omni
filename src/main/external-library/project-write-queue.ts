const queues = new Map<string, Promise<void>>();

// Agent scopes differ, but every external installation in a project shares one lock file.
export function serializeExternalProjectWrites<T>(
  profile: string,
  projectIds: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(projectIds.map((id) => JSON.stringify([profile, id])))];
  const previous = keys.flatMap((key) => queues.get(key) ?? []);
  const result = Promise.all(previous).then(run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) queues.set(key, tail);
  void tail.then(() => {
    for (const key of keys) if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}
