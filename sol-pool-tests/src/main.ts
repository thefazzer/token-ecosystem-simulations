import { makeMint, connection, fundPayer } from "./chain.js";
import { runDamm } from "./damm.js";
import { runDlmm } from "./dlmm.js";
import { runOrca } from "./orca.js";
import { finish, record } from "./report.js";

const SUPPLY = 1_000_000_000_000n;

async function main(): Promise<void> {
  record(
    "paul.mm",
    "SKIP",
    "no MM authored by thefazzer. token-ecosystem-simulations is empty; bankingenv and botbotabot have none; mfd0 and l0ds0 are not accessible. thefazzer/dlmm-sdk market_making is upstream Meteora (andrewsource147), not Paul.",
  );

  const conn = connection();
  const payer = await fundPayer(conn);
  const a = await makeMint(conn, payer, SUPPLY);
  const b = await makeMint(conn, payer, SUPPLY);
  console.log(`payer ${payer.publicKey.toBase58()}`);
  console.log(`mints ${a.mint.toBase58()} ${b.mint.toBase58()}`);

  await runOrca(conn, payer, a.mint, b.mint);
  await runDlmm(conn, payer, a.mint, b.mint);
  await runDamm(conn, payer, a.mint, b.mint);

  process.exitCode = finish();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
