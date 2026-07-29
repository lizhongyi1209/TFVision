import { NextResponse } from "next/server";
import { clearDiagnostics, diagnosticsCapacity, getDiagnostics } from "@/lib/diagnostics.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ entries: getDiagnostics(), maxEntries: diagnosticsCapacity() });
}

export async function DELETE() {
  clearDiagnostics();
  return NextResponse.json({ ok: true });
}
