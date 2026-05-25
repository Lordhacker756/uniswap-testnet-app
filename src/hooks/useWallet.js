import { useState, useCallback, useEffect } from 'react'
import { ethers } from 'ethers'
import { SEPOLIA_CHAIN_ID } from '../constants/addresses'

export function useWallet() {
  const [provider, setProvider] = useState(null)
  const [signer, setSigner] = useState(null)
  const [account, setAccount] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [balance, setBalance] = useState(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState(null)

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError('MetaMask not found. Please install MetaMask.')
      return
    }
    setIsConnecting(true)
    setError(null)
    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum)
      await browserProvider.send('eth_requestAccounts', [])
      const walletSigner = await browserProvider.getSigner()
      const address = await walletSigner.getAddress()
      const network = await browserProvider.getNetwork()
      const bal = await browserProvider.getBalance(address)

      setProvider(browserProvider)
      setSigner(walletSigner)
      setAccount(address)
      setChainId(Number(network.chainId))
      setBalance(ethers.formatEther(bal))
    } catch (err) {
      setError(err.message)
    } finally {
      setIsConnecting(false)
    }
  }, [])

  const disconnect = useCallback(() => {
    setProvider(null)
    setSigner(null)
    setAccount(null)
    setChainId(null)
    setBalance(null)
  }, [])

  const switchToSepolia = useCallback(async () => {
    if (!window.ethereum) return
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${SEPOLIA_CHAIN_ID.toString(16)}` }],
      })
    } catch (err) {
      if (err.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: `0x${SEPOLIA_CHAIN_ID.toString(16)}`,
            chainName: 'Sepolia Testnet',
            rpcUrls: ['https://rpc.sepolia.org', 'https://sepolia.infura.io/v3/'],
            nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
            blockExplorerUrls: ['https://sepolia.etherscan.io'],
          }],
        })
      }
    }
  }, [])

  useEffect(() => {
    if (!window.ethereum) return

    const handleAccountsChanged = (accounts) => {
      if (accounts.length === 0) disconnect()
      else connect()
    }
    const handleChainChanged = () => connect()

    window.ethereum.on('accountsChanged', handleAccountsChanged)
    window.ethereum.on('chainChanged', handleChainChanged)
    return () => {
      window.ethereum.removeListener('accountsChanged', handleAccountsChanged)
      window.ethereum.removeListener('chainChanged', handleChainChanged)
    }
  }, [connect, disconnect])

  return {
    provider,
    signer,
    account,
    chainId,
    balance,
    isConnecting,
    error,
    connect,
    disconnect,
    switchToSepolia,
    isConnected: !!account,
    isWrongNetwork: chainId !== null && chainId !== SEPOLIA_CHAIN_ID,
  }
}
