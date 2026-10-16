import { useCallback } from "react";

import type { SourceOwnership } from "../../domain/project-source-registry";
import type { DesktopApi } from "../../shared/ipc";
import type { RegisterProjectResponse, RegisterSourceResponse, RegistryViewResponse } from "../../shared/registry-ipc";
import { readError } from "../app-helpers";
import { useI18n } from "../i18n";
import type { RegistryError } from "./registry-error";
import type { RegistryMutationToken } from "./registry-operation-coordinator";

type LoadOptions = Readonly<{ mutationToken?: RegistryMutationToken; preserveSelection?: boolean }>;
type RegistrationOptions = Pick<LoadOptions, "preserveSelection"> & Readonly<{ grantHandle?: string }>;

export type RegistryRegistrationActions = Readonly<{
  registerProject: (options?: RegistrationOptions) => Promise<RegisterProjectResponse | null>;
  registerSource: (
    ownership?: SourceOwnership,
    options?: RegistrationOptions,
  ) => Promise<RegisterSourceResponse | null>;
}>;

export function useRegistryRegistration(
  input: Readonly<{
    api: Pick<DesktopApi, "registerProject" | "registerSource" | "registerInspectedProject"> | null;
    sourceOwnership: SourceOwnership;
    beginRegistryMutation: () => RegistryMutationToken | null;
    endRegistryMutation: (token: RegistryMutationToken) => void;
    clearRegistrySelection: () => void;
    loadRegistry: (options?: LoadOptions) => Promise<RegistryViewResponse | null>;
    setRegistry: (value: RegistryViewResponse) => void;
    setRegistryError: (value: RegistryError | null) => void;
  }>,
): RegistryRegistrationActions {
  const { t } = useI18n();
  const {
    api,
    sourceOwnership,
    beginRegistryMutation,
    endRegistryMutation,
    clearRegistrySelection,
    loadRegistry,
    setRegistry,
    setRegistryError,
  } = input;

  const registerProject = useCallback(
    async (options: RegistrationOptions = {}): Promise<RegisterProjectResponse | null> => {
      if (!api) {
        setRegistryError({ message: t("errors.preloadUnavailable") });
        return null;
      }
      const mutationToken = beginRegistryMutation();
      if (mutationToken === null) return null;
      setRegistryError(null);
      try {
        if (options.grantHandle && !api.registerInspectedProject)
          throw new Error("Project inspection registration is unavailable.");
        const result = options.grantHandle
          ? await api.registerInspectedProject!({ grantHandle: options.grantHandle })
          : await api.registerProject();
        if (result.status === "ready") {
          await loadRegistry({ mutationToken, preserveSelection: options.preserveSelection });
        } else if (result.status === "corrupt") {
          clearRegistrySelection();
          setRegistry(result);
        } else if (result.status === "inaccessible") {
          setRegistryError({ message: t("registry.registrationFailed"), detail: result.diagnostic });
        } else if (result.status === "revision-conflict") {
          setRegistryError({ message: t("registry.registryChanged") });
        }
        return result;
      } catch (registrationError: unknown) {
        setRegistryError(readError(registrationError, t("registry.registrationFailed")));
        return null;
      } finally {
        endRegistryMutation(mutationToken);
      }
    },
    [
      api,
      beginRegistryMutation,
      clearRegistrySelection,
      endRegistryMutation,
      loadRegistry,
      setRegistry,
      setRegistryError,
      t,
    ],
  );

  const registerSource = useCallback(
    async (
      ownership: SourceOwnership = sourceOwnership,
      options: RegistrationOptions = {},
    ): Promise<RegisterSourceResponse | null> => {
      if (!api) {
        setRegistryError({ message: t("errors.preloadUnavailable") });
        return null;
      }
      const mutationToken = beginRegistryMutation();
      if (mutationToken === null) return null;
      setRegistryError(null);
      try {
        const result = await api.registerSource({ ownership });
        if (result.status === "ready") {
          await loadRegistry({ mutationToken, preserveSelection: options.preserveSelection });
        } else if (result.status === "corrupt") {
          clearRegistrySelection();
          setRegistry(result);
        } else if (result.status === "inaccessible") {
          setRegistryError({ message: t("registry.registrationFailed"), detail: result.diagnostic });
        } else if (result.status === "classification-conflict") {
          setRegistryError({ message: t("registry.registrationFailed"), detail: t("registry.classificationConflict") });
        } else if (result.status === "revision-conflict") {
          setRegistryError({ message: t("registry.registryChanged") });
        }
        return result;
      } catch (registrationError: unknown) {
        setRegistryError(readError(registrationError, t("registry.registrationFailed")));
        return null;
      } finally {
        endRegistryMutation(mutationToken);
      }
    },
    [
      api,
      beginRegistryMutation,
      clearRegistrySelection,
      endRegistryMutation,
      loadRegistry,
      setRegistry,
      setRegistryError,
      sourceOwnership,
      t,
    ],
  );

  return { registerProject, registerSource };
}
