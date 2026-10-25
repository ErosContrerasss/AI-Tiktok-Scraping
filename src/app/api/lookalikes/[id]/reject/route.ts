import { handle, type IdCtx } from "@/lib/http";
import { rejectLookalike } from "@/lib/lookalikes";

export const maxDuration = 300;

// "Dit is geen look-alike": undo its verdicts and blocks.
export const POST = handle(async (_req, { params }: IdCtx) => rejectLookalike(Number((await params).id)));
