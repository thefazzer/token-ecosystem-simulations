import { createRequire } from "node:module";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const dlmmSdk = require("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm") & {
  default?: typeof import("@meteora-ag/dlmm").default;
};
const DLMM = dlmmSdk.default ?? (dlmmSdk as unknown as typeof import("@meteora-ag/dlmm").default);
const { ActivationType, StrategyType, deriveBinArray, deriveCustomizablePermissionlessLbPair } = dlmmSdk;
import BN from "bn.js";
import { ownerBalance, sendAll, sendTx, tokenBalance } from "./chain.js";
import { record, shortErr } from "./report.js";

const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const BIN_STEP = new BN(10);
const FEE_BPS = new BN(10);
const MIN_BIN = -5;
const MAX_BIN = 5;

type Bal = { userX: bigint; userY: bigint; resX: bigint; resY: bigint };

async function balances(
  conn: Connection,
  owner: PublicKey,
  mintX: PublicKey,
  mintY: PublicKey,
  reserveX: PublicKey,
  reserveY: PublicKey,
): Promise<Bal> {
  const [userX, userY, resX, resY] = await Promise.all([
    ownerBalance(conn, mintX, owner),
    ownerBalance(conn, mintY, owner),
    tokenBalance(conn, reserveX),
    tokenBalance(conn, reserveY),
  ]);
  return { userX, userY, resX, resY };
}

function conserved(before: Bal, after: Bal): boolean {
  return (
    before.userX + before.resX === after.userX + after.resX &&
    before.userY + before.resY === after.userY + after.resY
  );
}

export async function runDlmm(
  conn: Connection,
  payer: Keypair,
  rawX: PublicKey,
  rawY: PublicKey,
): Promise<void> {
  const [tokenX, tokenY] = rawX.toBuffer().compare(rawY.toBuffer()) < 0
    ? [rawX, rawY]
    : [rawY, rawX];
  const owner = payer.publicKey;

  let pair: PublicKey;
  try {
    const tx = await DLMM.createCustomizablePermissionlessLbPair2(
      conn,
      BIN_STEP,
      tokenX,
      tokenY,
      new BN(0),
      FEE_BPS,
      ActivationType.Slot,
      false,
      owner,
      undefined,
      false,
      undefined,
      undefined,
      { cluster: "devnet" },
    );
    await sendTx(conn, payer, tx);
    [pair] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, DLMM_PROGRAM);
    record("dlmm.create_pool", "PASS", pair.toBase58());
  } catch (err) {
    record("dlmm.create_pool", "FAIL", shortErr(err));
    return;
  }

  const pool = await DLMM.create(conn, pair, { cluster: "devnet" });

  try {
    const bins = await pool.getBinArrayForSwap(true);
    const quote = pool.swapQuote(new BN(1_000_000), true, new BN(100), bins, false);
    const tx = await pool.swap({
      inToken: tokenX,
      outToken: tokenY,
      inAmount: quote.consumedInAmount,
      minOutAmount: quote.minOutAmount,
      lbPair: pair,
      user: owner,
      binArraysPubkey: quote.binArraysPubkey,
    });
    await sendTx(conn, payer, tx);
    record("dlmm.swap_before_bins", "FAIL", "swap succeeded with no liquidity");
  } catch (err) {
    record("dlmm.swap_before_bins", "BREAK", shortErr(err));
  }

  try {
    const indexes = [-1, 0, 1].map((n) => new BN(n));
    const ixs = await pool.initializeBinArrays(indexes, owner);
    if (ixs.length > 0) {
      const { Transaction } = await import("@solana/web3.js");
      const tx = new Transaction().add(...ixs);
      await sendTx(conn, payer, tx);
    }
    record("dlmm.init_bin_arrays", "PASS", `ixs ${ixs.length}`);
  } catch (err) {
    record("dlmm.init_bin_arrays", "FAIL", shortErr(err));
    return;
  }

  const { Keypair } = await import("@solana/web3.js");
  const position = Keypair.generate();
  const deposit = new BN(200_000_000_000);
  try {
    const txs = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      user: owner,
      totalXAmount: deposit,
      totalYAmount: deposit,
      strategy: {
        minBinId: MIN_BIN,
        maxBinId: MAX_BIN,
        strategyType: StrategyType.Spot,
      },
      slippage: 2,
    });
    await sendAll(conn, payer, txs, [position]);
    record("dlmm.add_liquidity", "PASS", `bins [${MIN_BIN},${MAX_BIN}]`);
  } catch (err) {
    record("dlmm.add_liquidity", "FAIL", shortErr(err));
    return;
  }

  await pool.refetchStates();
  const reserveX = pool.lbPair.reserveX;
  const reserveY = pool.lbPair.reserveY;
  const before = await balances(conn, owner, tokenX, tokenY, reserveX, reserveY);
  const binBefore = (await pool.getActiveBin()).binId;
  let quoted = 0n;
  try {
    const bins = await pool.getBinArrayForSwap(true);
    const quote = pool.swapQuote(new BN(5_000_000), true, new BN(50), bins, false);
    quoted = BigInt(quote.outAmount.toString());
    const tx = await pool.swap({
      inToken: tokenX,
      outToken: tokenY,
      inAmount: quote.consumedInAmount,
      minOutAmount: quote.minOutAmount,
      lbPair: pair,
      user: owner,
      binArraysPubkey: quote.binArraysPubkey,
    });
    await sendTx(conn, payer, tx);
  } catch (err) {
    record("dlmm.swap_in_range", "FAIL", shortErr(err));
    return;
  }
  await pool.refetchStates();
  const after = await balances(conn, owner, tokenX, tokenY, reserveX, reserveY);
  const binAfter = (await pool.getActiveBin()).binId;
  const spent = before.userX - after.userX;
  const got = after.userY - before.userY;
  const quoteOk = got === quoted || (quoted > got && quoted - got <= 2n);
  if (spent === 5_000_000n && got > 0n && binAfter <= binBefore && quoteOk && conserved(before, after)) {
    record("dlmm.swap_in_range", "PASS", `in ${spent} out ${got} quote ${quoted} bin ${binBefore}->${binAfter}`);
  } else {
    record(
      "dlmm.swap_in_range",
      "FAIL",
      `spent ${spent} got ${got} quote ${quoted} bin ${binBefore}->${binAfter} conserved ${conserved(before, after)}`,
    );
  }

  try {
    const positions = await pool.getPositionsByUserAndLbPair(owner);
    const pos = positions.userPositions.find((p) => p.publicKey.equals(position.publicKey));
    const fee = pos ? BigInt(pos.positionData.feeX.toString()) + BigInt(pos.positionData.feeY.toString()) : 0n;
    if (!pos || fee <= 0n) {
      record("dlmm.collect_fees", "FAIL", `fee ${fee}`);
    } else {
      const y0 = await ownerBalance(conn, tokenY, owner);
      const x0 = await ownerBalance(conn, tokenX, owner);
      const claimTxs = await pool.claimAllSwapFee({ owner, positions: [pos] });
      await sendAll(conn, payer, claimTxs);
      const y1 = await ownerBalance(conn, tokenY, owner);
      const x1 = await ownerBalance(conn, tokenX, owner);
      const gained = x1 - x0 + (y1 - y0);
      if (gained === fee) record("dlmm.collect_fees", "PASS", `collected ${gained}`);
      else record("dlmm.collect_fees", "FAIL", `fee ${fee} gained ${gained}`);
    }
  } catch (err) {
    record("dlmm.collect_fees", "FAIL", shortErr(err));
  }

  try {
    const bins = await pool.getBinArrayForSwap(true);
    const quote = pool.swapQuote(new BN("1000000000000"), true, new BN(1000), bins, true);
    const tx = await pool.swap({
      inToken: tokenX,
      outToken: tokenY,
      inAmount: quote.consumedInAmount,
      minOutAmount: quote.minOutAmount,
      lbPair: pair,
      user: owner,
      binArraysPubkey: quote.binArraysPubkey,
    });
    await sendTx(conn, payer, tx);
    await pool.refetchStates();
    const active = (await pool.getActiveBin()).binId;
    const positions = await pool.getPositionsByUserAndLbPair(owner);
    const pos = positions.userPositions.find((p) => p.publicKey.equals(position.publicKey));
    const yLeft = pos ? BigInt(pos.positionData.totalYAmount) : 1n;
    const feeBefore = pos
      ? BigInt(pos.positionData.feeX.toString()) + BigInt(pos.positionData.feeY.toString())
      : 0n;
    let second = "no-second-swap";
    try {
      const bins2 = await pool.getBinArrayForSwap(true);
      const quote2 = pool.swapQuote(new BN(1_000_000), true, new BN(100), bins2, false);
      const tx2 = await pool.swap({
        inToken: tokenX,
        outToken: tokenY,
        inAmount: quote2.consumedInAmount,
        minOutAmount: quote2.minOutAmount,
        lbPair: pair,
        user: owner,
        binArraysPubkey: quote2.binArraysPubkey,
      });
      await sendTx(conn, payer, tx2);
      second = "second-swap-landed";
    } catch (err) {
      second = shortErr(err);
    }
    const positions2 = await pool.getPositionsByUserAndLbPair(owner);
    const pos2 = positions2.userPositions.find((p) => p.publicKey.equals(position.publicKey));
    const feeAfter = pos2
      ? BigInt(pos2.positionData.feeX.toString()) + BigInt(pos2.positionData.feeY.toString())
      : feeBefore;
    const leftRange = active <= MIN_BIN;
    const oneSided = yLeft <= 1n;
    const feesFlat = feeAfter === feeBefore;
    if (leftRange && oneSided && feesFlat) {
      record("dlmm.out_of_range", "PASS", `bin ${active} ${second}`);
    } else {
      record(
        "dlmm.out_of_range",
        "FAIL",
        `bin ${active} yLeft ${yLeft} fees ${feeBefore}->${feeAfter} ${second}`,
      );
    }
  } catch (err) {
    record("dlmm.out_of_range", "BREAK", shortErr(err));
  }

  try {
    const bins = await pool.getBinArrayForSwap(false);
    const quote = pool.swapQuote(new BN(1), false, new BN(0), bins, false);
    if (quote.outAmount.isZero()) {
      record("dlmm.tiny_amount", "BREAK", `rounding: 1 in quotes 0 out, fee ${quote.fee.toString()}`);
    } else {
      const b0 = await balances(conn, owner, tokenX, tokenY, reserveX, reserveY);
      const tx = await pool.swap({
        inToken: tokenY,
        outToken: tokenX,
        inAmount: quote.consumedInAmount,
        minOutAmount: quote.minOutAmount,
        lbPair: pair,
        user: owner,
        binArraysPubkey: quote.binArraysPubkey,
      });
      await sendTx(conn, payer, tx);
      const b1 = await balances(conn, owner, tokenX, tokenY, reserveX, reserveY);
      record(
        "dlmm.tiny_amount",
        conserved(b0, b1) ? "PASS" : "FAIL",
        `out ${b1.userX - b0.userX} quote ${quote.outAmount.toString()}`,
      );
    }
  } catch (err) {
    record("dlmm.tiny_amount", "BREAK", shortErr(err));
  }

  try {
    const farIndex = new BN(30);
    const [farArray] = deriveBinArray(pair, farIndex, DLMM_PROGRAM);
    const exists = await conn.getAccountInfo(farArray);
    if (exists) {
      record("dlmm.bin_array_uninit", "SKIP", "far bin array already exists");
    } else {
      const log = console.error;
      console.error = () => {};
      try {
        const tx = await pool.swap({
          inToken: tokenY,
          outToken: tokenX,
          inAmount: new BN(1_000_000),
          minOutAmount: new BN(0),
          lbPair: pair,
          user: owner,
          binArraysPubkey: [farArray],
        });
        await sendTx(conn, payer, tx);
        record("dlmm.bin_array_uninit", "FAIL", "swap accepted an uninitialized bin array");
      } finally {
        console.error = log;
      }
    }
  } catch (err) {
    record("dlmm.bin_array_uninit", "BREAK", shortErr(err));
  }

  try {
    const b0 = await balances(conn, owner, tokenX, tokenY, reserveX, reserveY);
    const txs = await pool.removeLiquidity({
      user: owner,
      position: position.publicKey,
      fromBinId: MIN_BIN,
      toBinId: MAX_BIN,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });
    await sendAll(conn, payer, txs);
    const b1 = await balances(conn, owner, tokenX, tokenY, reserveX, reserveY);
    const returned = b1.userX + b1.userY > b0.userX + b0.userY;
    if (returned && conserved(b0, b1)) {
      record("dlmm.remove_liquidity", "PASS", `protocol-fee residue X ${b1.resX} Y ${b1.resY}`);
    } else {
      record(
        "dlmm.remove_liquidity",
        "FAIL",
        `returned ${returned} conserved ${conserved(b0, b1)} resX ${b1.resX} resY ${b1.resY}`,
      );
    }
  } catch (err) {
    record("dlmm.remove_liquidity", "FAIL", shortErr(err));
  }

}
