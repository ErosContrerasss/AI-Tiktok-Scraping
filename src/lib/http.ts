import { NextResponse } from "next/server";
import { ZodError } from "zod";

// Wraps a route handler so errors come back as JSON instead of an HTML 500.
export function handle<C>(fn: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      return NextResponse.json(await fn(req, ctx));
    } catch (e) {
      const status = e instanceof ZodError ? 400 : 500;
      const message = e instanceof ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e);
      console.error(e);
      return NextResponse.json({ error: message }, { status });
    }
  };
}

export type IdCtx = { params: Promise<{ id: string }> };

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}
