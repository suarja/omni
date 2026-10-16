#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* A Mach-O launcher keeps its signature in the executable, unlike a shell script's xattrs. */
int main(int argc, char **argv) {
  char executable[PATH_MAX], resolved[PATH_MAX], runtime[PATH_MAX], node[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) || !realpath(executable, resolved)) {
    fputs("Omni MCP could not locate its application. Reinstall Omni Desktop.\n", stderr);
    return 1;
  }
  char *slash = strrchr(resolved, '/');
  if (!slash) return 1;
  *slash = '\0';
  if (snprintf(node, sizeof(node), "%s/../MacOS/Omni Desktop", resolved) >= (int)sizeof(node) ||
      snprintf(runtime, sizeof(runtime), "%s/app/plugins/omni/runtime/omni-mcp.mjs", resolved) >= (int)sizeof(runtime)) return 1;
  char **args = calloc((size_t)argc + 2, sizeof(char *));
  if (!args) return 1;
  args[0] = node;
  args[1] = runtime;
  for (int index = 1; index < argc; index++) args[index + 1] = argv[index];
  if (setenv("ELECTRON_RUN_AS_NODE", "1", 1)) return 1;
  execv(node, args);
  perror("Omni MCP could not start its runtime. Reinstall Omni Desktop");
  free(args);
  return 1;
}
