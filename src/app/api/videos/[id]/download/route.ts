import { downloadVideo } from "@/lib/download";
import { handle, type IdCtx } from "@/lib/http";

export const maxDuration = 300;

export const POST = handle(async (_req, { params }: IdCtx) => downloadVideo((await params).id));
