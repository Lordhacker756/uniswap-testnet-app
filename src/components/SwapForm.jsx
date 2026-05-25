import { useState, useEffect, useRef } from 'react'
import { ethers } from 'ethers'
import { TOKENS, ADDRESSES, FEE_TIERS } from '../constants/addresses'
import { ERC20_ABI, WETH_ABI, SWAP_ROUTER_ABI, QUOTER_V2_ABI } from '../constants/abis'

export function SwapForm({ signer, provider, account }) {
  const [tokenIn, setTokenIn] = useState(TOKENS[0])   // ETH
  const [tokenOut, setTokenOut] = useState(TOKENS[2])  // USDC
  const [amountIn, setAmountIn] = useState('')
  const [amountOut, setAmountOut] = useState('')
  const [feeTier, setFeeTier] = useState(3000)
  const [slippage, setSlippage] = useState('0.5')
  const [isQuoting, setIsQuoting] = useState(false)
  const [isApproving, setIsApproving] = useState(false)
  const [isSwapping, setIsSwapping] = useState(false)
  const [needsApproval, setNeedsApproval] = useState(false)
  const [tokenInBalance, setTokenInBalance] = useState('')
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')

  // Wrap / Unwrap section
  const [wrapAmount, setWrapAmount] = useState('')
  const [isWrapping, setIsWrapping] = useState(false)
  const [wrapError, setWrapError] = useState('')
  const [wrapTx, setWrapTx] = useState('')

  const quoteTimer = useRef(null)

  // Fetch tokenIn balance
  useEffect(() => {
    if (!account || !provider) return
    const fetch = async () => {
      try {
        if (tokenIn.isNative) {
          const bal = await provider.getBalance(account)
          setTokenInBalance(ethers.formatEther(bal))
        } else {
          const t = new ethers.Contract(tokenIn.address, ERC20_ABI, provider)
          const bal = await t.balanceOf(account)
          setTokenInBalance(ethers.formatUnits(bal, tokenIn.decimals))
        }
      } catch { setTokenInBalance('0') }
    }
    fetch()
  }, [account, provider, tokenIn, txHash])

  // Check approval for ERC20 input
  useEffect(() => {
    if (!account || !provider || tokenIn.isNative || !amountIn || parseFloat(amountIn) <= 0) {
      setNeedsApproval(false)
      return
    }
    const check = async () => {
      try {
        const t = new ethers.Contract(tokenIn.address, ERC20_ABI, provider)
        const allowance = await t.allowance(account, ADDRESSES.SWAP_ROUTER)
        const required = ethers.parseUnits(amountIn, tokenIn.decimals)
        setNeedsApproval(allowance < required)
      } catch { setNeedsApproval(false) }
    }
    check()
  }, [account, provider, tokenIn, amountIn])

  // Auto-quote with debounce
  useEffect(() => {
    if (!amountIn || parseFloat(amountIn) <= 0 || !provider) {
      setAmountOut('')
      return
    }
    if (quoteTimer.current) clearTimeout(quoteTimer.current)
    quoteTimer.current = setTimeout(async () => {
      setIsQuoting(true)
      setError('')
      try {
        const quoter = new ethers.Contract(ADDRESSES.QUOTER_V2, QUOTER_V2_ABI, provider)
        const tIn = tokenIn.isNative ? ADDRESSES.WETH9 : tokenIn.address
        const tOut = tokenOut.isNative ? ADDRESSES.WETH9 : tokenOut.address
        const [outRaw] = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: tIn,
          tokenOut: tOut,
          amountIn: ethers.parseUnits(amountIn, tokenIn.decimals),
          fee: feeTier,
          sqrtPriceLimitX96: 0n,
        })
        setAmountOut(ethers.formatUnits(outRaw, tokenOut.decimals))
      } catch {
        setAmountOut('')
        setError('No pool liquidity for this pair / fee tier')
      } finally {
        setIsQuoting(false)
      }
    }, 500)
    return () => clearTimeout(quoteTimer.current)
  }, [amountIn, tokenIn, tokenOut, feeTier, provider])

  const handleApprove = async () => {
    if (!signer) return
    setIsApproving(true)
    setError('')
    try {
      const t = new ethers.Contract(tokenIn.address, ERC20_ABI, signer)
      const tx = await t.approve(
        ADDRESSES.SWAP_ROUTER,
        ethers.parseUnits(amountIn, tokenIn.decimals)
      )
      await tx.wait()
      setNeedsApproval(false)
    } catch (e) {
      setError(e.reason || e.message)
    } finally {
      setIsApproving(false)
    }
  }

  const handleSwap = async () => {
    if (!signer || !amountIn || !amountOut) return
    setIsSwapping(true)
    setError('')
    setTxHash('')
    try {
      const router = new ethers.Contract(ADDRESSES.SWAP_ROUTER, SWAP_ROUTER_ABI, signer)
      const tIn = tokenIn.isNative ? ADDRESSES.WETH9 : tokenIn.address
      const tOut = tokenOut.isNative ? ADDRESSES.WETH9 : tokenOut.address
      const amtIn = ethers.parseUnits(amountIn, tokenIn.decimals)
      const amtOut = ethers.parseUnits(amountOut, tokenOut.decimals)
      const bps = Math.round(parseFloat(slippage) * 100)
      const amtOutMin = (amtOut * BigInt(10000 - bps)) / 10000n

      const tx = await router.exactInputSingle(
        { tokenIn: tIn, tokenOut: tOut, fee: feeTier, recipient: account, amountIn: amtIn, amountOutMinimum: amtOutMin, sqrtPriceLimitX96: 0n },
        { value: tokenIn.isNative ? amtIn : 0n }
      )
      setTxHash(tx.hash)
      await tx.wait()
      setAmountIn('')
      setAmountOut('')
    } catch (e) {
      setError(e.reason || e.message)
    } finally {
      setIsSwapping(false)
    }
  }

  const handleWrap = async (wrap) => {
    if (!signer || !wrapAmount) return
    setIsWrapping(true)
    setWrapError('')
    setWrapTx('')
    try {
      const weth = new ethers.Contract(ADDRESSES.WETH9, WETH_ABI, signer)
      const amt = ethers.parseEther(wrapAmount)
      const tx = wrap
        ? await weth.deposit({ value: amt })
        : await weth.withdraw(amt)
      setWrapTx(tx.hash)
      await tx.wait()
      setWrapAmount('')
    } catch (e) {
      setWrapError(e.reason || e.message)
    } finally {
      setIsWrapping(false)
    }
  }

  const swapTokens = () => {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAmountIn('')
    setAmountOut('')
  }

  const swappableTokens = TOKENS.filter(t => t.symbol !== tokenOut.symbol)
  const outputTokens = TOKENS.filter(t => t.symbol !== tokenIn.symbol)

  return (
    <div className="forms-wrapper">
      <div className="form-card">
        <h2>Swap</h2>

        <div className="input-group">
          <div className="input-label-row">
            <label>From</label>
            {tokenInBalance && (
              <span className="balance" onClick={() => setAmountIn(parseFloat(tokenInBalance).toString())}>
                Balance: {parseFloat(tokenInBalance).toFixed(6)}
              </span>
            )}
          </div>
          <div className="token-input-row">
            <select value={tokenIn.symbol} onChange={e => {
              setTokenIn(TOKENS.find(t => t.symbol === e.target.value))
              setAmountIn('')
              setAmountOut('')
            }}>
              {swappableTokens.map(t => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
            </select>
            <input
              type="number"
              placeholder="0.0"
              value={amountIn}
              min="0"
              onChange={e => setAmountIn(e.target.value)}
            />
          </div>
        </div>

        <button className="switch-btn" onClick={swapTokens}>⇅</button>

        <div className="input-group">
          <label>To</label>
          <div className="token-input-row">
            <select value={tokenOut.symbol} onChange={e => {
              setTokenOut(TOKENS.find(t => t.symbol === e.target.value))
              setAmountOut('')
            }}>
              {outputTokens.map(t => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
            </select>
            <input
              type="number"
              placeholder={isQuoting ? 'Fetching...' : '0.0'}
              value={isQuoting ? '' : amountOut}
              readOnly
            />
          </div>
        </div>

        <div className="row-two-cols">
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
          <div className="input-group">
            <label>Slippage %</label>
            <input type="number" value={slippage} min="0.01" max="50" step="0.1" onChange={e => setSlippage(e.target.value)} />
          </div>
        </div>

        {error && <div className="msg-error">{error}</div>}
        {txHash && (
          <div className="msg-success">
            Swap submitted! <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noopener noreferrer">View ↗</a>
          </div>
        )}

        {!account ? (
          <div className="msg-info">Connect wallet to swap</div>
        ) : needsApproval ? (
          <button className="btn-primary" onClick={handleApprove} disabled={isApproving}>
            {isApproving ? 'Approving...' : `Approve ${tokenIn.symbol}`}
          </button>
        ) : (
          <button className="btn-primary" onClick={handleSwap} disabled={isSwapping || !amountIn || !amountOut || isQuoting}>
            {isSwapping ? 'Swapping...' : 'Swap'}
          </button>
        )}
      </div>

      {/* Wrap / Unwrap utility */}
      <div className="form-card">
        <h3>Wrap / Unwrap ETH</h3>
        <p className="sub-text">Convert ETH ↔ WETH for use in liquidity pools.</p>
        <div className="input-group">
          <label>Amount (ETH / WETH)</label>
          <input type="number" placeholder="0.0" value={wrapAmount} min="0" onChange={e => setWrapAmount(e.target.value)} />
        </div>
        {wrapError && <div className="msg-error">{wrapError}</div>}
        {wrapTx && (
          <div className="msg-success">
            Done! <a href={`https://sepolia.etherscan.io/tx/${wrapTx}`} target="_blank" rel="noopener noreferrer">View ↗</a>
          </div>
        )}
        <div className="button-row">
          <button className="btn-secondary" onClick={() => handleWrap(true)} disabled={isWrapping || !account || !wrapAmount}>
            {isWrapping ? '...' : 'Wrap ETH → WETH'}
          </button>
          <button className="btn-secondary" onClick={() => handleWrap(false)} disabled={isWrapping || !account || !wrapAmount}>
            {isWrapping ? '...' : 'Unwrap WETH → ETH'}
          </button>
        </div>
      </div>
    </div>
  )
}
