import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type Signer,
} from "@solana/web3.js";

export const RPC_URL = process.env.SOL_POOL_RPC ?? "http://127.0.0.1:8899";
export const DECIMALS = 6;
export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;

export function connection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

export async function fundPayer(conn: Connection): Promise<Keypair> {
  const payer = Keypair.generate();
  const sig = await conn.requestAirdrop(payer.publicKey, 100 * 1_000_000_000);
  const latest = await conn.getLatestBlockhash();
  await conn.confirmTransaction(
    { signature: sig, ...latest },
    "confirmed",
  );
  return payer;
}

export async function makeMint(
  conn: Connection,
  payer: Keypair,
  supply: bigint,
): Promise<{ mint: PublicKey; ata: PublicKey }> {
  const mint = await createMint(
    conn,
    payer,
    payer.publicKey,
    null,
    DECIMALS,
  );
  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    mint,
    payer.publicKey,
  );
  await mintTo(conn, payer, mint, ata.address, payer, supply);
  return { mint, ata: ata.address };
}

export async function tokenBalance(
  conn: Connection,
  tokenAccount: PublicKey,
): Promise<bigint> {
  const info = await conn.getAccountInfo(tokenAccount);
  if (!info) return 0n;
  const acc = await getAccount(conn, tokenAccount);
  return acc.amount;
}

export async function ownerBalance(
  conn: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  return tokenBalance(conn, ata);
}

export async function sendTx(
  conn: Connection,
  payer: Keypair,
  tx: Transaction,
  extra: Signer[] = [],
): Promise<string> {
  tx.feePayer = payer.publicKey;
  const latest = await conn.getLatestBlockhash();
  tx.recentBlockhash = latest.blockhash;
  tx.sign(payer, ...extra);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await conn.confirmTransaction(
    { signature: sig, ...latest },
    "confirmed",
  );
  return sig;
}

export async function sendAll(
  conn: Connection,
  payer: Keypair,
  txs: Transaction | Transaction[],
  extra: Signer[] = [],
): Promise<void> {
  const list = Array.isArray(txs) ? txs : [txs];
  for (const tx of list) {
    await sendTx(conn, payer, tx, extra);
  }
}
