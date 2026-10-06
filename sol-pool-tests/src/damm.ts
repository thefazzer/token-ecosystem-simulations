import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dammSdk = require("@meteora-ag/cp-amm-sdk") as typeof import("@meteora-ag/cp-amm-sdk");
const { BaseFeeMode, CpAmm, derivePositionNftAccount, getBaseFeeParams, getSqrtPriceFromPrice } = dammSdk;
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { ownerBalance, sendTx, tokenBalance } from "./chain.js";
import { record, shortErr } from "./report.js";

type Bal = { userA: bigint; userB: bigint; vaultA: bigint; vaultB: bigint };

function conserved(before: Bal, after: Bal): boolean {
  return (
    before.userA + before.vaultA === after.userA + after.vaultA &&
    before.userB + before.vaultB === after.userB + after.vaultB
  );
}

export async function runDamm(
  conn: Connection,
  payer: Keypair,
  mintA: PublicKey,
  mintB: PublicKey,
): Promise<void> {
  const cp = new CpAmm(conn);
  const owner = payer.publicKey;
  const amount = new BN(100_000_000_000);
  const sqrtMin = getSqrtPriceFromPrice("0.25", 6, 6);
  const sqrtMax = getSqrtPriceFromPrice("4", 6, 6);
  const positionNft = Keypair.generate();

  let pool: PublicKey;
  let position: PublicKey;
  try {
    const prepared = cp.preparePoolCreationParams({
      tokenAAmount: amount,
      tokenBAmount: amount,
      minSqrtPrice: sqrtMin,
      maxSqrtPrice: sqrtMax,
      collectFeeMode: 0,
    });
    const baseFee = getBaseFeeParams({
      baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
      feeTimeSchedulerParam: {
        startingFeeBps: 100,
        endingFeeBps: 100,
        numberOfPeriod: 0,
        totalDuration: 0,
      },
    });
    const created = await cp.createCustomPool({
      payer: owner,
      creator: owner,
      positionNft: positionNft.publicKey,
      tokenAMint: mintA,
      tokenBMint: mintB,
      tokenAAmount: amount,
      tokenBAmount: amount,
      sqrtMinPrice: sqrtMin,
      sqrtMaxPrice: sqrtMax,
      liquidityDelta: prepared.liquidityDelta,
      initSqrtPrice: prepared.initSqrtPrice,
      poolFees: {
        baseFee,
        compoundingFeeBps: 0,
        padding: 0,
        dynamicFee: null,
      },
      hasAlphaVault: false,
      activationType: 0,
      collectFeeMode: 0,
      activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
    });
    await sendTx(conn, payer, created.tx, [positionNft]);
    pool = created.pool;
    position = created.position;
    record("damm.create_pool", "PASS", pool.toBase58());
  } catch (err) {
    record("damm.create_pool", "BREAK", shortErr(err));
    return;
  }

  const state = await cp.fetchPoolState(pool);
  const vaultA = state.tokenAVault;
  const vaultB = state.tokenBVault;
  const nftAccount = derivePositionNftAccount(positionNft.publicKey);

  const read = async (): Promise<Bal> => {
    const [userA, userB, vA, vB] = await Promise.all([
      ownerBalance(conn, mintA, owner),
      ownerBalance(conn, mintB, owner),
      tokenBalance(conn, vaultA),
      tokenBalance(conn, vaultB),
    ]);
    return { userA, userB, vaultA: vA, vaultB: vB };
  };

  const slot = await conn.getSlot();
  const before = await read();
  const sqrtBefore = BigInt(state.sqrtPrice.toString());
  let quoted = 0n;
  try {
    const quote = cp.getQuote({
      inAmount: new BN(5_000_000),
      inputTokenMint: mintA,
      slippage: 0.5,
      poolState: state,
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot: slot,
      tokenADecimal: 6,
      tokenBDecimal: 6,
    });
    quoted = BigInt(quote.swapOutAmount.toString());
    const tx = await cp.swap({
      payer: owner,
      pool,
      inputTokenMint: mintA,
      outputTokenMint: mintB,
      amountIn: new BN(5_000_000),
      minimumAmountOut: quote.minSwapOutAmount,
      tokenAMint: mintA,
      tokenBMint: mintB,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });
    await sendTx(conn, payer, tx);
  } catch (err) {
    record("damm.swap", "FAIL", shortErr(err));
    return;
  }
  const after = await read();
  const state2 = await cp.fetchPoolState(pool);
  const sqrtAfter = BigInt(state2.sqrtPrice.toString());
  const spent = before.userA - after.userA;
  const got = after.userB - before.userB;
  const quoteOk = got === quoted || (quoted > got && quoted - got <= 2n);
  if (spent === 5_000_000n && got > 0n && sqrtAfter < sqrtBefore && quoteOk && conserved(before, after)) {
    record("damm.swap", "PASS", `in ${spent} out ${got} quote ${quoted}`);
  } else {
    record(
      "damm.swap",
      "FAIL",
      `spent ${spent} got ${got} quote ${quoted} priceDown ${sqrtAfter < sqrtBefore} conserved ${conserved(before, after)}`,
    );
  }

  try {
    const b0 = await read();
    const tx = await cp.claimPositionFee({
      owner,
      position,
      pool,
      positionNftAccount: nftAccount,
      tokenAMint: mintA,
      tokenBMint: mintB,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
    });
    await sendTx(conn, payer, tx);
    const b1 = await read();
    const gained = b1.userA - b0.userA + (b1.userB - b0.userB);
    if (gained > 0n && conserved(b0, b1)) record("damm.collect_fees", "PASS", `collected ${gained}`);
    else record("damm.collect_fees", "FAIL", `gained ${gained} conserved ${conserved(b0, b1)}`);
  } catch (err) {
    record("damm.collect_fees", "BREAK", shortErr(err));
  }

  try {
    const tx = await cp.swap({
      payer: owner,
      pool,
      inputTokenMint: mintA,
      outputTokenMint: mintB,
      amountIn: new BN(1_000_000),
      minimumAmountOut: new BN("1000000000000"),
      tokenAMint: mintA,
      tokenBMint: mintB,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });
    await sendTx(conn, payer, tx);
    record("damm.slippage_limit", "FAIL", "impossible min-out landed");
  } catch (err) {
    record("damm.slippage_limit", "PASS", shortErr(err));
  }

  try {
    const b0 = await read();
    const quote = cp.getQuote({
      inAmount: new BN(1),
      inputTokenMint: mintA,
      slippage: 0,
      poolState: await cp.fetchPoolState(pool),
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot: await conn.getSlot(),
      tokenADecimal: 6,
      tokenBDecimal: 6,
    });
    const tx = await cp.swap({
      payer: owner,
      pool,
      inputTokenMint: mintA,
      outputTokenMint: mintB,
      amountIn: new BN(1),
      minimumAmountOut: new BN(0),
      tokenAMint: mintA,
      tokenBMint: mintB,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    });
    await sendTx(conn, payer, tx);
    const b1 = await read();
    const got = b1.userB - b0.userB;
    if (got === 0n) {
      record("damm.tiny_amount", "BREAK", `rounding: 1 in -> 0 out (quote ${quote.swapOutAmount.toString()})`);
    } else {
      record("damm.tiny_amount", conserved(b0, b1) ? "PASS" : "FAIL", `out ${got} quote ${quote.swapOutAmount.toString()}`);
    }
  } catch (err) {
    record("damm.tiny_amount", "BREAK", shortErr(err));
  }

  try {
    const pos = await cp.fetchPositionState(position);
    const liquidity = pos.unlockedLiquidity?.toString?.() ?? "unknown";
    const b0 = await read();
    const tx = await cp.removeAllLiquidity({
      owner,
      position,
      pool,
      positionNftAccount: nftAccount,
      tokenAAmountThreshold: new BN(0),
      tokenBAmountThreshold: new BN(0),
      tokenAMint: mintA,
      tokenBMint: mintB,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      vestings: [],
      currentPoint: new BN(await conn.getSlot()),
    });
    await sendTx(conn, payer, tx);
    const b1 = await read();
    const returned = b1.userA + b1.userB > b0.userA + b0.userB;
    if (returned && conserved(b0, b1)) {
      record("damm.remove_liquidity", "PASS", `liquidity was ${liquidity}`);
    } else {
      record("damm.remove_liquidity", "FAIL", `returned ${returned} conserved ${conserved(b0, b1)}`);
    }
  } catch (err) {
    record("damm.remove_liquidity", "FAIL", shortErr(err));
  }
}
