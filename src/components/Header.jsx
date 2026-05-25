export function Header({ wallet }) {
  const { account, balance, chainId, isConnecting, isConnected, isWrongNetwork, connect, disconnect, switchToSepolia } = wallet

  const shortAddress = account ? `${account.slice(0, 6)}...${account.slice(-4)}` : ''

  return (
    <header className="header">
      <div className="header-inner">
        <div className="logo">
          <span className="logo-icon">🦄</span>
          <span className="logo-text">Uniswap Testnet</span>
          <span className="network-badge">Sepolia</span>
        </div>

        <div className="wallet-section">
          {isWrongNetwork && (
            <button className="btn-warning" onClick={switchToSepolia}>
              Switch to Sepolia
            </button>
          )}
          {!isConnected ? (
            <button className="btn-connect" onClick={connect} disabled={isConnecting}>
              {isConnecting ? 'Connecting...' : 'Connect Wallet'}
            </button>
          ) : (
            <div className="wallet-info">
              <span className="wallet-balance">{parseFloat(balance || '0').toFixed(4)} ETH</span>
              <button className="btn-address" onClick={disconnect} title="Click to disconnect">
                <span className="dot-green" />
                {shortAddress}
              </button>
            </div>
          )}
        </div>
      </div>

      {wallet.error && (
        <div className="header-error">{wallet.error}</div>
      )}
    </header>
  )
}
