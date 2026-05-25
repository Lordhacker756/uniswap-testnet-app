import { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import { ADDRESSES, TOKENS } from '../constants/addresses'
import { POSITION_MANAGER_ABI, ERC20_ABI, POOL_ABI, FACTORY_ABI } from '../constants/abis'

// ── Math helpers ───────────────────────────────────────────────────────────────

// token0-per-token1 display price from a tick (e.g. 3000 USDC per WETH)
function tickToDisplayPrice(tick, t0dec, t1dec) {
  if (tick <= -887000) return 0
  if (tick >= 887000) return Infinity
  const priceRaw = Math.pow(1.0001, tick)                     // token1_raw / token0_raw
  const t1perT0human = priceRaw * Math.pow(10, t0dec - t1dec) // token1 human / token0 human
  return t1perT0human === 0 ? Infinity : 1 / t1perT0human     // token0 per token1
}

// How many token0/token1 is currently locked by a position
function positionAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper, currentTick) {
  const Q96f = Math.pow(2, 96)
  const sqrtP = Number(sqrtPriceX96) / Q96f
  const sqrtA = Math.sqrt(Math.pow(1.0001, tickLower))
  const sqrtB = Math.sqrt(Math.pow(1.0001, tickUpper))
  const L = Number(liquidity)
  let a0 = 0, a1 = 0
  if (currentTick < tickLower) {
    a0 = L * (1 / sqrtA - 1 / sqrtB)
  } else if (currentTick >= tickUpper) {
    a1 = L * (sqrtB - sqrtA)
  } else {
    a0 = L * (1 / sqrtP - 1 / sqrtB)
    a1 = L * (sqrtP - sqrtA)
  }
  return { a0: Math.max(0, a0), a1: Math.max(0, a1) }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function PositionsView({ signer, provider, account }) {
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [collecting, setCollecting] = useState({})
  const [removing, setRemoving] = useState({})
  const [removePct, setRemovePct] = useState({})   // tokenId → 25|50|75|100
  const [txLinks, setTxLinks] = useState({})         // tokenId → etherscan url

  const fetchPositions = useCallback(async () => {
    if (!account || !provider) return
    setLoading(true)
    setError('')
    try {
      const pm = new ethers.Contract(ADDRESSES.POSITION_MANAGER, POSITION_MANAGER_ABI, provider)
      const factory = new ethers.Contract(ADDRESSES.FACTORY, FACTORY_ABI, provider)

      const count = Number(await pm.balanceOf(account))
      if (count === 0) { setPositions([]); return }

      const tokenIds = await Promise.all(
        Array.from({ length: count }, (_, i) => pm.tokenOfOwnerByIndex(account, i))
      )

      const currentBlock = await provider.getBlockNumber()

      const settled = await Promise.allSettled(tokenIds.map(async (tokenId) => {
        const p = await pm.positions(tokenId)
        const [, , token0Addr, token1Addr, fee, tickLower, tickUpper, liquidity,
               fg0Last, fg1Last, owed0, owed1] = p

        // Skip burned positions
        if (liquidity === 0n && owed0 === 0n && owed1 === 0n) return null

        // Resolve token info (fall back to on-chain symbol if unknown)
        const resolve = async (addr) => {
          const known = TOKENS.find(t => t.address?.toLowerCase() === addr.toLowerCase())
          if (known) return known
          try {
            const c = new ethers.Contract(addr, ERC20_ABI, provider)
            const [sym, dec] = await Promise.all([c.symbol(), c.decimals()])
            return { symbol: sym, decimals: Number(dec), address: addr, isNative: false }
          } catch { return { symbol: addr.slice(0, 6), decimals: 18, address: addr, isNative: false } }
        }
        const [t0, t1] = await Promise.all([resolve(token0Addr), resolve(token1Addr)])

        // Pool state
        const poolAddr = await factory.getPool(token0Addr, token1Addr, fee)
        const pool = new ethers.Contract(poolAddr, POOL_ABI, provider)
        const [sqrtPriceX96, currentTick] = await pool.slot0()

        const tL = Number(tickLower), tU = Number(tickUpper), tC = Number(currentTick)
        const inRange = tC >= tL && tC < tU

        // Locked token amounts
        const { a0, a1 } = positionAmounts(liquidity, sqrtPriceX96, tL, tU, tC)
        const amount0 = a0 / Math.pow(10, t0.decimals)
        const amount1 = a1 / Math.pow(10, t1.decimals)

        // Uncollected fees (simulate collect)
        let fees0 = 0, fees1 = 0
        try {
          const MAX128 = 2n ** 128n - 1n
          const [f0, f1] = await pm.collect.staticCall({
            tokenId, recipient: account, amount0Max: MAX128, amount1Max: MAX128,
          })
          fees0 = Number(ethers.formatUnits(f0, t0.decimals))
          fees1 = Number(ethers.formatUnits(f1, t1.decimals))
        } catch { /* no fees or call failed */ }

        // APY estimate via fee-growth-rate over recent blocks
        // feeGrowthGlobal0X128 accumulates fees per unit of global liquidity
        let apyEstimate = null
        let dailyFee0 = null, dailyFee1 = null
        if (inRange && liquidity > 0n) {
          try {
            const LOOK_BACK = Math.min(currentBlock - 1, 300)  // ~1h of blocks
            const [fg0Now, fg1Now, fg0Past, fg1Past, blockNow, blockPast] = await Promise.all([
              pool.feeGrowthGlobal0X128(),
              pool.feeGrowthGlobal1X128(),
              pool.feeGrowthGlobal0X128({ blockTag: currentBlock - LOOK_BACK }),
              pool.feeGrowthGlobal1X128({ blockTag: currentBlock - LOOK_BACK }),
              provider.getBlock(currentBlock),
              provider.getBlock(currentBlock - LOOK_BACK),
            ])
            const elapsed = blockNow.timestamp - blockPast.timestamp   // seconds
            if (elapsed > 0 && fg0Now >= fg0Past) {
              // fees per unit liquidity per second (Q128 fixed-point → divide by 2^128)
              const Q128f = Number(2n ** 128n)
              const rate0perSec = Number(fg0Now - fg0Past) / Q128f / elapsed
              const rate1perSec = Number(fg1Now - fg1Past) / Q128f / elapsed
              const L = Number(liquidity)
              // our position earns rate * L tokens (raw) per second
              dailyFee0 = rate0perSec * L * 86400 / Math.pow(10, t0.decimals)
              dailyFee1 = rate1perSec * L * 86400 / Math.pow(10, t1.decimals)

              // APY% — need a USD value for the position
              // Use USDC as base if either token is USDC; otherwise skip %
              const currentPriceT0perT1 = tickToDisplayPrice(tC, t0.decimals, t1.decimals)
              let posValueUSD = null
              if (t0.symbol === 'USDC') {
                posValueUSD = amount0 + amount1 * currentPriceT0perT1
              } else if (t1.symbol === 'USDC') {
                posValueUSD = amount1 + amount0 / currentPriceT0perT1
              }
              if (posValueUSD && posValueUSD > 0) {
                // annualise fee income in USD
                let annualUSD = 0
                if (t0.symbol === 'USDC') annualUSD += dailyFee0 * 365
                if (t1.symbol === 'USDC') annualUSD += dailyFee1 * 365
                // for non-USDC tokens approximate via pool price
                if (t1.symbol !== 'USDC' && t0.symbol !== 'USDC') {
                  annualUSD = (dailyFee0 + dailyFee1) * 365  // token-agnostic
                }
                if (t0.symbol === 'WETH' && t1.symbol !== 'USDC') {
                  annualUSD += dailyFee0 * 365 * currentPriceT0perT1
                }
                apyEstimate = posValueUSD > 0 ? (annualUSD / posValueUSD) * 100 : null
              }
            }
          } catch { /* fee growth query failed – network may not have old block */ }
        }

        // Price range for display
        const priceLower = tickToDisplayPrice(tL, t0.decimals, t1.decimals)
        const priceUpper = tickToDisplayPrice(tU, t0.decimals, t1.decimals)
        const currentPrice = tickToDisplayPrice(tC, t0.decimals, t1.decimals)

        const fmt = (n) => n === Infinity ? '∞' : n === 0 ? '0' : n < 0.0001 ? n.toExponential(3) : n.toFixed(4)

        return {
          tokenId: tokenId.toString(),
          t0, t1,
          fee: Number(fee),
          tickLower: tL, tickUpper: tU,
          liquidity: liquidity.toString(),
          amount0, amount1,
          fees0, fees1,
          inRange,
          priceLower: fmt(priceLower),
          priceUpper: fmt(priceUpper),
          currentPrice: fmt(currentPrice),
          apyEstimate,
          dailyFee0, dailyFee1,
          poolAddr,
        }
      }))

      setPositions(settled.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean))
    } catch (e) {
      setError(e.reason || e.message)
    } finally {
      setLoading(false)
    }
  }, [account, provider])

  useEffect(() => { fetchPositions() }, [fetchPositions])

  // ── Collect fees ──────────────────────────────────────────────────────────────
  const handleCollect = async (pos) => {
    if (!signer) return
    setCollecting(c => ({ ...c, [pos.tokenId]: true }))
    setError('')
    try {
      const pm = new ethers.Contract(ADDRESSES.POSITION_MANAGER, POSITION_MANAGER_ABI, signer)
      const MAX128 = 2n ** 128n - 1n
      const tx = await pm.collect({
        tokenId: BigInt(pos.tokenId),
        recipient: account,
        amount0Max: MAX128,
        amount1Max: MAX128,
      })
      setTxLinks(l => ({ ...l, [pos.tokenId]: `https://sepolia.etherscan.io/tx/${tx.hash}` }))
      await tx.wait()
      await fetchPositions()
    } catch (e) {
      setError(e.reason || e.message)
    } finally {
      setCollecting(c => ({ ...c, [pos.tokenId]: false }))
    }
  }

  // ── Remove liquidity (decrease + collect in one multicall) ────────────────────
  const handleRemove = async (pos) => {
    if (!signer) return
    const pct = removePct[pos.tokenId] ?? 100
    setRemoving(r => ({ ...r, [pos.tokenId]: true }))
    setError('')
    try {
      const pm = new ethers.Contract(ADDRESSES.POSITION_MANAGER, POSITION_MANAGER_ABI, signer)
      const liqToRemove = BigInt(Math.floor(Number(pos.liquidity) * pct / 100))
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
      const MAX128 = 2n ** 128n - 1n

      // Batch decreaseLiquidity + collect into one transaction via multicall
      const decreaseData = pm.interface.encodeFunctionData('decreaseLiquidity', [{
        tokenId: BigInt(pos.tokenId),
        liquidity: liqToRemove,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      }])
      const collectData = pm.interface.encodeFunctionData('collect', [{
        tokenId: BigInt(pos.tokenId),
        recipient: account,
        amount0Max: MAX128,
        amount1Max: MAX128,
      }])

      const tx = await pm.multicall([decreaseData, collectData])
      setTxLinks(l => ({ ...l, [pos.tokenId]: `https://sepolia.etherscan.io/tx/${tx.hash}` }))
      await tx.wait()
      await fetchPositions()
    } catch (e) {
      setError(e.reason || e.message)
    } finally {
      setRemoving(r => ({ ...r, [pos.tokenId]: false }))
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="positions-header">
        <h2>My Positions</h2>
        <button className="btn-secondary small" onClick={fetchPositions} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error && <div className="msg-error">{error}</div>}

      {!account ? (
        <div className="empty-state">Connect your wallet to view positions.</div>
      ) : loading ? (
        <div className="empty-state">Fetching positions…</div>
      ) : positions.length === 0 ? (
        <div className="empty-state">No active positions found.<br />Add liquidity first.</div>
      ) : (
        <div className="positions-list">
          {positions.map(pos => {
            const hasFees = pos.fees0 > 0.000000001 || pos.fees1 > 0.000000001
            const busy = collecting[pos.tokenId] || removing[pos.tokenId]

            return (
              <div key={pos.tokenId} className="position-card">

                {/* Header row */}
                <div className="pos-title-row">
                  <div className="pos-pair-info">
                    <span className="pos-pair">{pos.t0.symbol}/{pos.t1.symbol}</span>
                    <span className="pos-fee-badge">{pos.fee / 10000}%</span>
                    <span className={`pos-range-badge ${pos.inRange ? 'in' : 'out'}`}>
                      {pos.inRange ? '● In Range' : '○ Out of Range'}
                    </span>
                  </div>
                  <span className="pos-id">#{pos.tokenId}</span>
                </div>

                {/* Stats grid */}
                <div className="pos-grid">
                  <StatBox label="Price Range" value={`${pos.priceLower} – ${pos.priceUpper}`} sub={`${pos.t0.symbol} per ${pos.t1.symbol}`} />
                  <StatBox label="Current Price" value={pos.currentPrice} sub={`${pos.t0.symbol} per ${pos.t1.symbol}`} />
                  <StatBox label={`${pos.t0.symbol} Deposited`} value={pos.amount0.toFixed(6)} />
                  <StatBox label={`${pos.t1.symbol} Deposited`} value={pos.amount1.toFixed(6)} />

                  <StatBox
                    label={`Claimable ${pos.t0.symbol} Fees`}
                    value={pos.fees0.toFixed(8)}
                    accent="green"
                    highlight
                  />
                  <StatBox
                    label={`Claimable ${pos.t1.symbol} Fees`}
                    value={pos.fees1.toFixed(8)}
                    accent="green"
                    highlight
                  />

                  {(pos.dailyFee0 !== null || pos.dailyFee1 !== null) && (
                    <StatBox
                      label="Est. Daily Fee Income"
                      value={[
                        pos.dailyFee0 !== null && pos.dailyFee0 > 1e-9 ? `${pos.dailyFee0.toFixed(6)} ${pos.t0.symbol}` : null,
                        pos.dailyFee1 !== null && pos.dailyFee1 > 1e-9 ? `${pos.dailyFee1.toFixed(6)} ${pos.t1.symbol}` : null,
                      ].filter(Boolean).join(' + ') || '< dust'}
                      sub="based on last ~1h of on-chain fee growth"
                      wide
                    />
                  )}

                  {pos.apyEstimate !== null && pos.apyEstimate > 0 && (
                    <StatBox
                      label="Estimated APY"
                      value={`${pos.apyEstimate < 0.01 ? '< 0.01' : pos.apyEstimate.toFixed(2)}%`}
                      sub="annualised from recent fee rate"
                      accent="pink"
                      wide
                    />
                  )}

                  {!pos.inRange && (
                    <StatBox
                      label="APY"
                      value="0% – out of range"
                      sub="position earns no fees until price re-enters range"
                      wide
                    />
                  )}
                </div>

                {/* Tx link */}
                {txLinks[pos.tokenId] && (
                  <div className="msg-success small-msg">
                    Last tx: <a href={txLinks[pos.tokenId]} target="_blank" rel="noopener noreferrer">View on Etherscan ↗</a>
                  </div>
                )}

                {/* Actions */}
                <div className="pos-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => handleCollect(pos)}
                    disabled={busy || !hasFees}
                    title={!hasFees ? 'No fees to collect yet' : ''}
                  >
                    {collecting[pos.tokenId] ? 'Collecting…' : 'Collect Fees'}
                  </button>

                  <div className="remove-row">
                    <select
                      value={removePct[pos.tokenId] ?? 100}
                      onChange={e => setRemovePct(p => ({ ...p, [pos.tokenId]: Number(e.target.value) }))}
                      disabled={busy}
                    >
                      <option value={25}>25%</option>
                      <option value={50}>50%</option>
                      <option value={75}>75%</option>
                      <option value={100}>100%</option>
                    </select>
                    <button
                      className="btn-secondary danger"
                      onClick={() => handleRemove(pos)}
                      disabled={busy || pos.liquidity === '0'}
                    >
                      {removing[pos.tokenId] ? 'Removing…' : 'Remove Liquidity'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StatBox({ label, value, sub, accent, highlight, wide }) {
  return (
    <div className={`stat-box ${highlight ? 'highlighted' : ''} ${wide ? 'wide' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${accent ? `accent-${accent}` : ''}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
