import { handle, jsonBody, type IdCtx } from "@/lib/http";
import { buildPlaybook } from "@/lib/playbook";

export const maxDuration = 800;

export const POST = handle(async (req, { params }: IdCtx) => {
  const body = await jsonBody(req);
  return buildPlaybook((await params).id, { limit: body.limit ? Number(body.limit) : undefined });
});
