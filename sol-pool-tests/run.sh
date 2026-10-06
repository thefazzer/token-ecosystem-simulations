#!/usr/bin/env bash
# One command: localnet only. Clones program bytes read-only from devnet, then
# runs throwaway-keypair tests against 127.0.0.1. No mainnet transactions.
set -euo pipefail
cd "$(dirname "$0")"

export PATH="${HOME}/.local/share/solana/install/active_release/bin:${PATH}"
RPC="${SOL_POOL_RPC:-http://127.0.0.1:8899}"
LEDGER="${SOL_POOL_LEDGER:-/tmp/sol-pool-ledger}"
SESSION="sol-pool-validator"
TMUX=(tmux -f /exec-daemon/tmux.portal.conf)
if ! command -v tmux >/dev/null; then
  TMUX=(tmux)
fi

if ! command -v solana-test-validator >/dev/null; then
  echo "solana-test-validator missing. Install Agave: https://docs.anza.xyz/cli/install"
  exit 1
fi

if ! solana cluster-version -u "$RPC" >/dev/null 2>&1; then
  rm -rf "$LEDGER"
  "${TMUX[@]}" has-session -t "=$SESSION" 2>/dev/null && "${TMUX[@]}" kill-session -t "$SESSION" || true
  "${TMUX[@]}" new-session -d -s "$SESSION" -- bash -lc "
    export PATH=\"${HOME}/.local/share/solana/install/active_release/bin:\$PATH\"
    exec solana-test-validator --reset \
      --ledger '$LEDGER' \
      --url https://api.devnet.solana.com \
      --clone-upgradeable-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc \
      --clone-upgradeable-program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo \
      --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
      --clone FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR \
      --clone 475EJ7JqnRpVLoFVzp2ruEYvWWMCf6Z8KMWRujtXXNSU \
      --clone CtfHwxDmdYtoWyeSyh3NUWk43FnehVhhtwuYdWwZcVyt \
      --clone DV9sQ4gQTYeEodFap6xiiJkcmYYr94EPFmu7gWXaQTym \
      --clone nhg1SS1hNFnJKZrJ9FBf3L6SxTjwEnkehN7dmAbg25t \
      --bind-address 127.0.0.1 \
      --rpc-port 8899 \
      --faucet-port 9900 \
      --limit-ledger-size 50000000
  "
  for _ in $(seq 1 90); do
    if solana cluster-version -u "$RPC" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  solana cluster-version -u "$RPC" >/dev/null
fi

if [[ ! -d node_modules ]]; then
  npm install --silent
fi

exec npx tsx src/main.ts
