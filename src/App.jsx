import { useState } from 'react'
import { Header } from './components/Header'
import { SwapForm } from './components/SwapForm'
import { LiquidityForm } from './components/LiquidityForm'
import { PositionsView } from './components/PositionsView'
import { useWallet } from './hooks/useWallet'
import './index.css'

export default function App() {
  const [tab, setTab] = useState('swap')
  const wallet = useWallet()

  return (
    <div className="app">
      <Header wallet={wallet} />

      <main className="main">
        {wallet.isWrongNetwork && (
          <div className="network-warning">
            You are on the wrong network. Please switch to Sepolia testnet.
          </div>
        )}

        <div className="tab-nav">
          <button className={`tab-btn ${tab === 'swap' ? 'active' : ''}`} onClick={() => setTab('swap')}>
            Swap
          </button>
          <button className={`tab-btn ${tab === 'liquidity' ? 'active' : ''}`} onClick={() => setTab('liquidity')}>
            Add Liquidity
          </button>
          <button className={`tab-btn ${tab === 'positions' ? 'active' : ''}`} onClick={() => setTab('positions')}>
            My Positions
          </button>
        </div>

        <div className="tab-content">
          {tab === 'swap' && (
            <SwapForm signer={wallet.signer} provider={wallet.provider} account={wallet.account} />
          )}
          {tab === 'liquidity' && (
            <LiquidityForm signer={wallet.signer} provider={wallet.provider} account={wallet.account} />
          )}
          {tab === 'positions' && (
            <PositionsView signer={wallet.signer} provider={wallet.provider} account={wallet.account} />
          )}
        </div>

        <p className="faucet-note">
          Need Sepolia ETH?{' '}
          <a href="https://sepoliafaucet.com" target="_blank" rel="noopener noreferrer">sepoliafaucet.com</a>
          {' '}|{' '}
          <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer">USDC faucet (Circle)</a>
        </p>
      </main>
    </div>
  )
}
