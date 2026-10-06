import { address, type Address, type KeyPairSigner } from "@solana/kit";
import {
  WhirlpoolDeployment,
  closePosition,
  createConcentratedLiquidityPool,
  decreaseLiquidityInstructions,
  harvestPosition,
  harvestPositionInstructions,
  openConcentratedPositionWithTickBounds,
  orderMints,
  setDefaultFunder,
  setJitoTipSetting,
  setPayerFromBytes,
  setPriorityFeeSetting,
  setRpc,
  swap,
  swapInstructions,
} from "@orca-so/whirlpools";
import {
  fetchMaybeTickArray,
  fetchPosition,
  fetchWhirlpool,
  getInitializeDynamicTickArrayInstruction,
  getPositionAddress,
  getTickArrayAddress,
} from "@orca-so/whirlpools-client";
import { buildAndSendTransaction } from "@orca-so/tx-sender";
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { ownerBalance, RPC_URL, tokenBalance } from "./chain.js";
import { record, shortErr } from "./report.js";

const DEP = WhirlpoolDeployment.devnet;
const TICK_SPACING = 8;
const TICK_ARRAY_SIZE = 88;

type Bal = { userA: bigint; userB: bigint; vaultA: bigint; vaultB: bigint };

function arrayStart(tick: number, tickSpacing: number): number {
  const span = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tick / span) * span;
}

async function balances(
  conn: Connection,
  owner: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
  vaultA: Address,
  vaultB: Address,
): Promise<Bal> {
  const [userA, userB, vaultBalA, vaultBalB] = await Promise.all([
    ownerBalance(conn, mintA, owner),
    ownerBalance(conn, mintB, owner),
    tokenBalance(conn, new PublicKey(vaultA)),
    tokenBalance(conn, new PublicKey(vaultB)),
  ]);
  return { userA, userB, vaultA: vaultBalA, vaultB: vaultBalB };
}

function conserved(before: Bal, after: Bal): boolean {
  return (
    before.userA + before.vaultA === after.userA + after.vaultA &&
    before.userB + before.vaultB === after.userB + after.vaultB
  );
}

async function initNeighborTickArrays(
  rpc: Awaited<ReturnType<typeof setRpc>>,
  pool: Address,
  signer: KeyPairSigner,
): Promise<number> {
  const whirl = await fetchWhirlpool(rpc, pool);
  const start = arrayStart(whirl.data.tickCurrentIndex, whirl.data.tickSpacing);
  const span = whirl.data.tickSpacing * TICK_ARRAY_SIZE;
  const ixs = [];
  for (const offset of [0, 1, 2, -1, -2]) {
    const startTick = start + offset * span;
    const [tickArray] = await getTickArrayAddress(pool, startTick, DEP.programId);
    const existing = await fetchMaybeTickArray(rpc, tickArray);
    if (existing.exists) continue;
    ixs.push(
      getInitializeDynamicTickArrayInstruction(
        {
          whirlpool: pool,
          funder: signer,
          tickArray,
          startTickIndex: startTick,
          idempotent: false,
        },
        { programAddress: DEP.programId },
      ),
    );
  }
  if (ixs.length > 0) await buildAndSendTransaction(ixs, signer);
  return ixs.length;
}

export async function runOrca(
  conn: Connection,
  payer: Keypair,
  mintAPk: PublicKey,
  mintBPk: PublicKey,
): Promise<void> {
  const rpc = await setRpc(RPC_URL);
  const signer = await setPayerFromBytes(new Uint8Array(payer.secretKey));
  setDefaultFunder(signer);
  setPriorityFeeSetting({ type: "none" });
  setJitoTipSetting({ type: "none" });

  const [mintA, mintB] = orderMints(
    address(mintAPk.toBase58()),
    address(mintBPk.toBase58()),
  );
  const mintAKey = new PublicKey(mintA);
  const mintBKey = new PublicKey(mintB);
  const owner = payer.publicKey;

  let pool: Address;
  try {
    const created = await createConcentratedLiquidityPool(
      mintA,
      mintB,
      TICK_SPACING,
      { initialPrice: 1, whirlpoolDeployment: DEP, funder: signer },
    );
    await created.callback();
    pool = created.poolAddress;
    record("orca.create_pool", "PASS", pool);
  } catch (err) {
    record("orca.create_pool", "FAIL", shortErr(err));
    return;
  }

  const whirl0 = await fetchWhirlpool(rpc, pool);
  const vaultA = whirl0.data.tokenVaultA;
  const vaultB = whirl0.data.tokenVaultB;

  try {
    const attempt = await swap(
      { inputAmount: 1_000_000n, mint: mintA },
      pool,
      { slippageToleranceBps: 100, signer, whirlpoolDeployment: DEP },
    );
    await attempt.callback();
    record("orca.swap_before_tick_arrays", "FAIL", "swap succeeded with no tick arrays");
  } catch (err) {
    record("orca.swap_before_tick_arrays", "BREAK", shortErr(err));
  }

  const wideLiq = 400_000_000_000n;
  const narrowLiq = 40_000_000_000n;
  let wideMint: Address;
  let narrowMint: Address;
  try {
    const wide = await openConcentratedPositionWithTickBounds(
      pool,
      { tokenMaxA: wideLiq, tokenMaxB: wideLiq },
      -800,
      800,
      { slippageToleranceBps: 500, funder: signer, whirlpoolDeployment: DEP, withTokenMetadataExtension: false },
    );
    await wide.callback();
    wideMint = wide.positionMint;
    const narrow = await openConcentratedPositionWithTickBounds(
      pool,
      { tokenMaxA: narrowLiq, tokenMaxB: narrowLiq },
      -16,
      16,
      { slippageToleranceBps: 500, funder: signer, whirlpoolDeployment: DEP, withTokenMetadataExtension: false },
    );
    await narrow.callback();
    narrowMint = narrow.positionMint;
    record("orca.add_liquidity", "PASS", "wide[-800,800] narrow[-16,16]");
  } catch (err) {
    record("orca.add_liquidity", "FAIL", shortErr(err));
    return;
  }

  let initialized = 0;
  try {
    initialized = await initNeighborTickArrays(rpc, pool, signer);
    record("orca.init_tick_arrays", "PASS", `initialized ${initialized}`);
  } catch (err) {
    record("orca.init_tick_arrays", "FAIL", shortErr(err));
    return;
  }

  const before = await balances(conn, owner, mintAKey, mintBKey, vaultA, vaultB);
  const sqrtBefore = (await fetchWhirlpool(rpc, pool)).data.sqrtPrice;
  const swapIn = 5_000_000n;
  let quotedOut = 0n;
  try {
    const built = await swap(
      { inputAmount: swapIn, mint: mintA },
      pool,
      { slippageToleranceBps: 50, signer, whirlpoolDeployment: DEP },
    );
    quotedOut = built.quote.tokenEstOut;
    await built.callback();
  } catch (err) {
    record("orca.swap_in_range", "FAIL", shortErr(err));
    return;
  }
  const after = await balances(conn, owner, mintAKey, mintBKey, vaultA, vaultB);
  const sqrtAfter = (await fetchWhirlpool(rpc, pool)).data.sqrtPrice;
  const spent = before.userA - after.userA;
  const got = after.userB - before.userB;
  const priceDown = sqrtAfter < sqrtBefore;
  const quoteOk = got === quotedOut || (quotedOut > got && quotedOut - got <= 2n);
  const cons = conserved(before, after);
  if (spent === swapIn && got > 0n && priceDown && quoteOk && cons) {
    record("orca.swap_in_range", "PASS", `in ${spent} out ${got} quote ${quotedOut}`);
  } else {
    record(
      "orca.swap_in_range",
      "FAIL",
      `spent ${spent} got ${got} quote ${quotedOut} priceDown ${priceDown} conserved ${cons}`,
    );
  }

  try {
    const preview = await harvestPositionInstructions(rpc, narrowMint, {
      authority: signer,
      whirlpoolDeployment: DEP,
    });
    const owed = preview.feesQuote.feeOwedA + preview.feesQuote.feeOwedB;
    if (owed <= 0n) {
      record("orca.fee_accrual", "FAIL", `fee owed ${owed}`);
    } else {
      const userBBefore = await ownerBalance(conn, mintBKey, owner);
      const userABefore = await ownerBalance(conn, mintAKey, owner);
      const harvested = await harvestPosition(narrowMint, {
        authority: signer,
        whirlpoolDeployment: DEP,
      });
      await harvested.callback();
      const userBAfter = await ownerBalance(conn, mintBKey, owner);
      const userAAfter = await ownerBalance(conn, mintAKey, owner);
      const gained = userAAfter - userABefore + (userBAfter - userBBefore);
      const again = await harvestPositionInstructions(rpc, narrowMint, {
        authority: signer,
        whirlpoolDeployment: DEP,
      });
      const residual = again.feesQuote.feeOwedA + again.feesQuote.feeOwedB;
      if (gained === owed && residual === 0n) {
        record("orca.collect_fees", "PASS", `collected ${gained}`);
      } else {
        record("orca.collect_fees", "FAIL", `owed ${owed} gained ${gained} residual ${residual}`);
      }
    }
  } catch (err) {
    record("orca.collect_fees", "FAIL", shortErr(err));
  }

  try {
    let tick = (await fetchWhirlpool(rpc, pool)).data.tickCurrentIndex;
    let pushes = 0;
    while (tick >= -16 && pushes < 6) {
      const built = await swap(
        { inputAmount: 30_000_000_000n, mint: mintA },
        pool,
        { slippageToleranceBps: 1500, signer, whirlpoolDeployment: DEP },
      );
      await built.callback();
      tick = (await fetchWhirlpool(rpc, pool)).data.tickCurrentIndex;
      pushes += 1;
    }
    const [posAddr] = await getPositionAddress(narrowMint, DEP.programId);
    const pos = await fetchPosition(rpc, posAddr);
    const quote = await decreaseLiquidityInstructions(
      rpc,
      narrowMint,
      { liquidity: pos.data.liquidity },
      { slippageToleranceBps: 0, authority: signer, whirlpoolDeployment: DEP },
    );
    const oneSided = quote.quote.tokenEstB <= 1n && quote.quote.tokenEstA > 0n;
    const feesBefore = await harvestPositionInstructions(rpc, narrowMint, {
      authority: signer,
      whirlpoolDeployment: DEP,
    });
    const owedBefore = feesBefore.feesQuote.feeOwedA + feesBefore.feesQuote.feeOwedB;
    if (tick < -16) {
      const extra = await swap(
        { inputAmount: 1_000_000n, mint: mintA },
        pool,
        { slippageToleranceBps: 500, signer, whirlpoolDeployment: DEP },
      );
      await extra.callback();
    }
    const feesAfter = await harvestPositionInstructions(rpc, narrowMint, {
      authority: signer,
      whirlpoolDeployment: DEP,
    });
    const owedAfter = feesAfter.feesQuote.feeOwedA + feesAfter.feesQuote.feeOwedB;
    if (tick < -16 && oneSided && owedAfter === owedBefore) {
      record("orca.out_of_range", "PASS", `tick ${tick} tokenB ${quote.quote.tokenEstB} fees flat ${owedAfter}`);
    } else {
      record(
        "orca.out_of_range",
        "FAIL",
        `tick ${tick} oneSided ${oneSided} tokenA ${quote.quote.tokenEstA} tokenB ${quote.quote.tokenEstB} fees ${owedBefore}->${owedAfter}`,
      );
    }
  } catch (err) {
    record("orca.out_of_range", "BREAK", shortErr(err));
  }

  try {
    const stale = await swapInstructions(
      rpc,
      { inputAmount: 2_000_000_000n, mint: mintB },
      pool,
      { slippageToleranceBps: 1, signer, whirlpoolDeployment: DEP },
    );
    const mover = await swap(
      { inputAmount: 20_000_000_000n, mint: mintB },
      pool,
      { slippageToleranceBps: 1000, signer, whirlpoolDeployment: DEP },
    );
    await mover.callback();
    const log = console.log;
    const errLog = console.error;
    const warn = console.warn;
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
    let slippage: { ok: boolean; detail: string };
    try {
      await buildAndSendTransaction(stale.instructions, signer);
      slippage = { ok: false, detail: "stale min-out swap landed" };
    } catch (err) {
      slippage = { ok: true, detail: shortErr(err) };
    } finally {
      console.log = log;
      console.error = errLog;
      console.warn = warn;
    }
    record("orca.slippage_limit", slippage.ok ? "PASS" : "FAIL", slippage.detail);
  } catch (err) {
    record("orca.slippage_limit", "BREAK", shortErr(err));
  }

  try {
    const b0 = await balances(conn, owner, mintAKey, mintBKey, vaultA, vaultB);
    const built = await swap(
      { inputAmount: 1n, mint: mintA },
      pool,
      { slippageToleranceBps: 0, signer, whirlpoolDeployment: DEP },
    );
    await built.callback();
    const b1 = await balances(conn, owner, mintAKey, mintBKey, vaultA, vaultB);
    const got = b1.userB - b0.userB;
    const cons = conserved(b0, b1) && b0.userA - b1.userA === 1n;
    record(
      "orca.tiny_amount",
      cons && got === 0n ? "BREAK" : cons ? "PASS" : "FAIL",
      got === 0n
        ? `rounding: 1 in -> 0 out (quote ${built.quote.tokenEstOut})`
        : `out ${got} quote ${built.quote.tokenEstOut} conserved ${cons}`,
    );
  } catch (err) {
    record("orca.tiny_amount", "BREAK", shortErr(err));
  }

  try {
    const built = await swap(
      { inputAmount: 10n ** 18n, mint: mintA },
      pool,
      { slippageToleranceBps: 0, signer, whirlpoolDeployment: DEP },
    );
    await built.callback();
    record("orca.huge_amount", "FAIL", "huge swap landed");
  } catch (err) {
    record("orca.huge_amount", "BREAK", `tick-array/liquidity limit: ${shortErr(err)}`);
  }

  try {
    const b0 = await balances(conn, owner, mintAKey, mintBKey, vaultA, vaultB);
    const closedNarrow = await closePosition(narrowMint, {
      slippageToleranceBps: 2000,
      authority: signer,
      whirlpoolDeployment: DEP,
    });
    await closedNarrow.callback();
    const closedWide = await closePosition(wideMint, {
      slippageToleranceBps: 2000,
      authority: signer,
      whirlpoolDeployment: DEP,
    });
    await closedWide.callback();
    const b1 = await balances(conn, owner, mintAKey, mintBKey, vaultA, vaultB);
    const returned = b1.userA + b1.userB > b0.userA + b0.userB;
    const residue = b1.vaultA + b1.vaultB;
    const residueOk = residue < wideLiq / 1000n;
    if (returned && conserved(b0, b1) && residueOk) {
      record("orca.remove_liquidity", "PASS", `protocol-fee residue A ${b1.vaultA} B ${b1.vaultB}`);
    } else {
      record(
        "orca.remove_liquidity",
        "FAIL",
        `returned ${returned} conserved ${conserved(b0, b1)} vaultA ${b1.vaultA} vaultB ${b1.vaultB}`,
      );
    }
  } catch (err) {
    record("orca.remove_liquidity", "FAIL", shortErr(err));
  }
}
