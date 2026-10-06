export type Status = "PASS" | "FAIL" | "BREAK" | "SKIP";

export type Row = { id: string; status: Status; detail: string };

const rows: Row[] = [];

export function record(id: string, status: Status, detail = ""): void {
  rows.push({ id, status, detail: detail.replace(/\s+/g, " ").slice(0, 220) });
  const extra = detail ? `  ${detail.replace(/\s+/g, " ").slice(0, 220)}` : "";
  console.log(`${status.padEnd(5)} ${id}${extra}`);
}

export function shortErr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const anchor = raw.match(/Error Message: ([^.\n]+)/);
  if (anchor) return anchor[1].trim().slice(0, 200);
  const line = raw.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? raw;
  return line.replace(/\s+/g, " ").slice(0, 200);
}

export function finish(): number {
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const pass = rows.filter((r) => r.status === "PASS").length;
  const brk = rows.filter((r) => r.status === "BREAK").length;
  const skip = rows.filter((r) => r.status === "SKIP").length;
  console.log(`--- ${pass} pass, ${fail} fail, ${brk} break, ${skip} skip ---`);
  return fail > 0 ? 1 : 0;
}
