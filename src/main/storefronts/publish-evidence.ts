import { hashContent } from "../marketplace-manifests";
import { hashes, rootIdentity, type PublicationContext } from "./publish-context";
import type { WorkshopEvidence } from "./publish-reader";
import type { PreparedPublication } from "./publish-merge";
import type { StorefrontControls } from "./publish-controls";
import type { NewDestination } from "./publish-plan";
export async function buildPublicationEvidence(
  ctx: PublicationContext,
  source: WorkshopEvidence,
  root: string,
  storefrontId: string,
  prepared: PreparedPublication,
  controlFiles: StorefrontControls,
  destination?: NewDestination,
): Promise<Readonly<{ fingerprint: string; approvalFingerprint: string }>> {
  const { raw, omni, workshopCommit, repository } = source;
  const { state, storefront, previous } = prepared;
  const { controls } = controlFiles;
  const evidence = {
    workshopId: ctx.workshop.id,
    storefrontId: storefrontId,
    revision: ctx.revision,
    workshopIdentity: await rootIdentity(ctx.workshopRoot),
    storefrontIdentity: destination?.fingerprint ?? (await rootIdentity(root)),
    raw: hashes(raw),
    omni: omni && hashContent(omni),
    storefront: hashes(storefront),
    workshopCommit,
    repository,
    state,
    controls,
    previous,
  };
  const fingerprint = hashContent(JSON.stringify(evidence));
  const approvalFingerprint = hashContent(
    JSON.stringify({ ...evidence, storefrontId: destination ? "new-storefront" : storefrontId }),
  );
  return { fingerprint, approvalFingerprint };
}
