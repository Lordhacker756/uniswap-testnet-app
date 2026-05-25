export const SEPOLIA_CHAIN_ID = 11155111

// Uniswap v3 official Sepolia deployments
export const ADDRESSES = {
  FACTORY: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  SWAP_ROUTER: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48',
  QUOTER_V2: '0xEd1f6473345F45b75833fd55D191EaA8783F4b48',
  POSITION_MANAGER: '0x1238536071E1c677A632429e3655c799b22cDA52',
  WETH9: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
}

export const TOKENS = [
  {
    symbol: 'ETH',
    name: 'Ethereum',
    address: null,
    decimals: 18,
    isNative: true,
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    decimals: 18,
    isNative: false,
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
    isNative: false,
  },
]

export const FEE_TIERS = [
  { label: '0.05%', value: 500, tickSpacing: 10 },
  { label: '0.3%', value: 3000, tickSpacing: 60 },
  { label: '1%', value: 10000, tickSpacing: 200 },
]

// Nearest valid full-range ticks (multiple of tickSpacing within ±887272)
export const FULL_RANGE_TICKS = {
  500:   { tickLower: -887270, tickUpper: 887270 },
  3000:  { tickLower: -887220, tickUpper: 887220 },
  10000: { tickLower: -887200, tickUpper: 887200 },
}
