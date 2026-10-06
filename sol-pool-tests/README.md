# sol-pool-tests

Localnet checks for Orca Whirlpools, Meteora DLMM, and Meteora DAMM v2. Programs are cloned read-only from devnet into `solana-test-validator`. Keys are generated in-process and funded with a local airdrop.

```bash
bash sol-pool-tests/run.sh
```

Requires Agave `solana-test-validator` on `PATH`. Nothing here sends a mainnet transaction.
