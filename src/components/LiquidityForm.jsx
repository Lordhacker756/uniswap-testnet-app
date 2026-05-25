import { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import { TOKENS, ADDRESSES, FEE_TIERS, FULL_RANGE_TICKS } from '../constants/addresses'
import { ERC20_ABI, POSITION_MANAGER_ABI, FACTORY_ABI, POOL_ABI } from '../constants/abis'

// BigInt Newton-Raphson square root
function bigIntSqrt(n) {
  if (n < 0n) throw new Error('negative sqrt')
  if (n === 0n) return 0n
  let x = n
  let y = (x + 1n) >> 1n
  while (y < x) { x = y; y = (n / y + y) >> 1n }
  return x
}

// Compute sqrtPriceX96 from a human-readable price (token1 per token0)
function encodeSqrtPriceX96(priceHuman, token0Decimals, token1Decimals) {
  const SCALE = 10n ** 18n
  const SQ_SCALE = 10n ** 9n // sqrt(SCALE)
  const Q96 = 2n ** 96n
  // price_raw = priceHuman * 10^(t1dec - t0dec)
  const decAdj = Math.pow(10, token1Decimals - token0Decimals)
  const priceRaw = priceHuman * decAdj
  const priceRawBig = BigInt(Math.floor(priceRaw * Number(SCALE)))
  return bigIntSqrt(priceRawBig * Q96 * Q96) / SQ_SCALE
}

function sortTokens(a, b) {
  return a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a]
}

function priceToTick(priceHuman, t0decimals, t1decimals) {
  const decAdj = Math.pow(10, t1decimals - t0decimals)
  const raw = priceHuman * decAdj
  return Math.floor(Math.log(raw) / Math.log(1.0001))
}

function roundTick(tick, tickSpacing, roundUp) {
  return roundUp
    ? Math.ceil(tick / tickSpacing) * tickSpacing
    : Math.floor(tick / tickSpacing) * tickSpacing
}

const LIQUIDITY_TOKENS = TOKENS.filter(t => !t.isNative) // WETH, USDC

export function LiquidityForm({ signer, provider, account }) {
  const [tokenA, setTokenA] = useState(LIQUIDITY_TOKENS[0]) // WETH
  const [tokenB, setTokenB] = useState(LIQUIDITY_TOKENS[1]) // USDC
  const [feeTier, setFeeTier] = useState(3000)
  const [fullRange, setFullRange] = useState(true)
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [amount0, setAmount0] = useState('')
  const [amount1, setAmount1] = useState('')
  const [initPrice, setInitPrice] = useState('')

  const [poolExists, setPoolExists] = useState(null)
  const [currentPrice, setCurrentPrice] = useState(null)  // token0/token1 in human units (large number)
  const [isLoadingPool, setIsLoadingPool] = useState(false)
  const [balances, setBalances] = useState({ t0: '', t1: '' })
  const [approved, setApproved] = useState({ t0: false, t1: false })

  const [isApproving0, setIsApproving0] = useState(false)
  const [isApproving1, setIsApproving1] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [isMinting, setIsMinting] = useState(false)
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')

  const [token0, token1] = sortTokens(tokenA, tokenB)
  const feeConfig = FEE_TIERS.find(f => f.value === feeTier)

  // Fetch pool state
  useEffect(() => {
    if (!provider) return
    setPoolExists(null)
    setCurrentPrice(null)
    setError('')
    const fetch = async () => {
      setIsLoadingPool(true)
      try {
        const factory = new ethers.Contract(ADDRESSES.FACTORY, FACTORY_ABI, provider)
        const poolAddr = await factory.getPool(token0.address, token1.address, feeTier)
        if (poolAddr === ethers.ZeroAddress) {
          setPoolExists(false)
        } else {
          setPoolExists(true)
          const pool = new ethers.Contract(poolAddr, POOL_ABI, provider)
          const [sqrtPriceX96] = await pool.slot0()
          // price = (sqrtPriceX96/2^96)^2 → token1_raw/token0_raw → convert to human
          const sqrtP = Number(sqrtPriceX96) / Math.pow(2, 96)
          const raw = sqrtP * sqrtP
          // Display as token0/token1 (the larger number, e.g. 3000 USDC per ETH)
          const humanT1perT0 = raw * Math.pow(10, token0.decimals - token1.decimals)
          // humanT1perT0 is WETH per USDC (tiny), so show inverse for display
          const display = 1 / humanT1perT0
          setCurrentPrice(display) // token0 per token1
        }
      } catch (e) {
        setError('Failed to load pool: ' + (e.reason || e.message))
      } finally {
        setIsLoadingPool(false)
      }
    }
    fetch()
  }, [provider, token0.address, token1.address, feeTier, txHash])

  // Fetch balances + allowances
  useEffect(() => {
    if (!account || !provider) return
    const fetch = async () => {
      try {
        const c0 = new ethers.Contract(token0.address, ERC20_ABI, provider)
        const c1 = new ethers.Contract(token1.address, ERC20_ABI, provider)
        const amt0 = amount0 ? ethers.parseUnits(amount0, token0.decimals) : 0n
        const amt1 = amount1 ? ethers.parseUnits(amount1, token1.decimals) : 0n
        const [b0, b1, a0, a1] = await Promise.all([
          c0.balanceOf(account),
          c1.balanceOf(account),
          c0.allowance(account, ADDRESSES.POSITION_MANAGER),
          c1.allowance(account, ADDRESSES.POSITION_MANAGER),
        ])
        setBalances({ t0: ethers.formatUnits(b0, token0.decimals), t1: ethers.formatUnits(b1, token1.decimals) })
        setApproved({ t0: a0 >= amt0, t1: a1 >= amt1 })
      } catch {}
    }
    fetch()
  }, [account, provider, token0, token1, amount0, amount1, txHash])

  const handleApprove = async (isT0) => {
    if (!signer) return
    const token = isT0 ? token0 : token1
    const amount = isT0 ? amount0 : amount1
    const setApproving = isT0 ? setIsApproving0 : setIsApproving1
    setApproving(true)
    setError('')
    try {
      const c = new ethers.Contract(token.address, ERC20_ABI, signer)
      const tx = await c.approve(ADDRESSES.POSITION_MANAGER, ethers.parseUnits(amount || '0', token.decimals))
      await tx.wait()
      setApproved(prev => ({ ...prev, [isT0 ? 't0' : 't1']: true }))
    } catch (e) {
      setError(e.reason || e.message)
    } finally {
      setApproving(false)
    }
  }

  const handleCreatePool = async () => {
    if (!signer || !initPrice) return
    setIsCreating(true)
    setError('')
    try {
      const pm = new ethers.Contract(ADDRESSES.POSITION_MANAGER, POSITION_MANAGER_ABI, signer)
      // User enters price as "token0 per token1" (e.g. 3000 USDC per ETH)
      // Pool stores price as token1/token0, so we invert
      const priceT1perT0 = 1 / parseFloat(initPrice)
      const sqrtPriceX96 = encodeSqrtPriceX96(priceT1perT0, token0.decimals, token1.decimals)
      const tx = await pm.createAndInitializePoolIfNecessary(token0.address, token1.address, feeTier, sqrtPriceX96)
      await tx.wait()
      setTxHash(tx.hash)
    } catch (e) {
      setError(e.reason || e.message)
    } finally {
      setIsCreating(false)
    }
  }

  const computeTicks = () => {
    if (fullRange) return FULL_RANGE_TICKS[feeTier]
    const ts = feeConfig.tickSpacing
    // minPrice is token0/token1 (large number) → invert for tick calc (token1/token0)
    const minT1perT0 = 1 / parseFloat(maxPrice || '1e10')
    const maxT1perT0 = 1 / parseFloat(minPrice || '1e-10')
    const rawLower = priceToTick(minT1perT0, token0.decimals, token1.decimals)
    const rawUpper = priceToTick(maxT1perT0, token0.decimals, token1.decimals)
    return {
      tickLower: roundTick(rawLower, ts, true),
      tickUpper: roundTick(rawUpper, ts, false),
    }
  }

  const handleAddLiquidity = async () => {
    if (!signer || !amount0 || !amount1) return
    setIsMinting(true)
    setError('')
    setTxHash('')
    try {
      const pm = new ethers.Contract(ADDRESSES.POSITION_MANAGER, POSITION_MANAGER_ABI, signer)
      const { tickLower, tickUpper } = computeTicks()
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
      const tx = await pm.mint({
        token0: token0.address,
        token1: token1.address,
        fee: feeTier,
        tickLower,
        tickUpper,
        amount0Desired: ethers.parseUnits(amount0, token0.decimals),
        amount1Desired: ethers.parseUnits(amount1, token1.decimals),
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: account,
        deadline,
      })
      setTxHash(tx.hash)
      await tx.wait()
      setAmount0('')
      setAmount1('')
    } catch (e) {
      setError(e.reason || e.message)
    } finally {
      setIsMinting(false)
    }
  }

  const needsApprove0 = amount0 && !approved.t0
  const needsApprove1 = amount1 && !approved.t1

  return (
    <div className="form-card">
      <h2>Add Liquidity</h2>

      {/* Token pair */}
      <div className="row-two-cols">
        <div className="input-group">
          <label>Token A</label>
          <select value={tokenA.symbol} onChange={e => { setTokenA(LIQUIDITY_TOKENS.find(t => t.symbol === e.target.value)); setAmount0(''); setAmount1('') }}>
            {LIQUIDITY_TOKENS.filter(t => t.symbol !== tokenB.symbol).map(t => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
          </select>
        </div>
        <div className="input-group">
          <label>Token B</label>
          <select value={tokenB.symbol} onChange={e => { setTokenB(LIQUIDITY_TOKENS.find(t => t.symbol === e.target.value)); setAmount0(''); setAmount1('') }}>
            {LIQUIDITY_TOKENS.filter(t => t.symbol !== tokenA.symbol).map(t => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
          </select>
        </div>
      </div>

      {/* Fee tier */}
      <div className="input-group">
        <label>Fee Tier</label>
        <div className="fee-tier-buttons">
          {FEE_TIERS.map(f => (
            <button key={f.value} className={`fee-btn ${feeTier === f.value ? 'active' : ''}`} onClick={() => setFeeTier(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Pool status */}
      {isLoadingPool && <div className="msg-info">Loading pool…</div>}

      {poolExists === false && (
        <div className="pool-create-box">
          <p className="sub-text">This pool does not exist yet. Set an initial price to create it.</p>
          <div className="input-group">
            <label>Initial Price ({token0.symbol} per {token1.symbol})</label>
            <input type="number" placeholder="e.g. 3000" value={initPrice} onChange={e => setInitPrice(e.target.value)} />
          </div>
          {!account ? (
            <div className="msg-info">Connect wallet to create pool</div>
          ) : (
            <button className="btn-secondary" onClick={handleCreatePool} disabled={isCreating || !initPrice}>
              {isCreating ? 'Creating Pool…' : 'Create Pool'}
            </button>
          )}
        </div>
      )}

      {poolExists === true && (
        <>
          {currentPrice !== null && (
            <div className="pool-info-box">
              Current Price: <strong>{currentPrice.toFixed(4)} {token0.symbol} per {token1.symbol}</strong>
            </div>
          )}

          {/* Price range */}
          <div className="input-group">
            <label className="range-label">
              <input type="checkbox" checked={fullRange} onChange={e => setFullRange(e.target.checked)} />
              {' '}Full Range
            </label>
          </div>

          {!fullRange && (
            <div className="row-two-cols">
              <div className="input-group">
                <label>Min Price ({token0.symbol}/{token1.symbol})</label>
                <input type="number" placeholder="0.0" value={minPrice} onChange={e => setMinPrice(e.target.value)} />
              </div>
              <div className="input-group">
                <label>Max Price ({token0.symbol}/{token1.symbol})</label>
                <input type="number" placeholder="∞" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} />
              </div>
            </div>
          )}

          {/* Amounts */}
          <div className="input-group">
            <div className="input-label-row">
              <label>{token0.symbol} Amount</label>
              {balances.t0 && <span className="balance">Balance: {parseFloat(balances.t0).toFixed(6)}</span>}
            </div>
            <input type="number" placeholder="0.0" value={amount0} min="0" onChange={e => setAmount0(e.target.value)} />
          </div>

          <div className="input-group">
            <div className="input-label-row">
              <label>{token1.symbol} Amount</label>
              {balances.t1 && <span className="balance">Balance: {parseFloat(balances.t1).toFixed(6)}</span>}
            </div>
            <input type="number" placeholder="0.0" value={amount1} min="0" onChange={e => setAmount1(e.target.value)} />
          </div>

          {error && <div className="msg-error">{error}</div>}
          {txHash && (
            <div className="msg-success">
              Position minted! <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noopener noreferrer">View ↗</a>
            </div>
          )}

          {!account ? (
            <div className="msg-info">Connect wallet to add liquidity</div>
          ) : (
            <div className="action-buttons">
              {needsApprove0 && (
                <button className="btn-secondary" onClick={() => handleApprove(true)} disabled={isApproving0}>
                  {isApproving0 ? 'Approving…' : `Approve ${token0.symbol}`}
                </button>
              )}
              {needsApprove1 && (
                <button className="btn-secondary" onClick={() => handleApprove(false)} disabled={isApproving1}>
                  {isApproving1 ? 'Approving…' : `Approve ${token1.symbol}`}
                </button>
              )}
              <button
                className="btn-primary full-width"
                onClick={handleAddLiquidity}
                disabled={isMinting || !amount0 || !amount1 || !!needsApprove0 || !!needsApprove1}
              >
                {isMinting ? 'Adding Liquidity…' : 'Add Liquidity'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
