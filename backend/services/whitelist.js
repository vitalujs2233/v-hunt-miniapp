export const VERIFIED_TOKENS = [
  { symbol: 'TON', master: 'NATIVE_TON' },
  { symbol: 'USDT', master: 'PUT_USDT_MASTER_ADDRESS_HERE' },
  { symbol: 'NOT', master: 'PUT_NOT_MASTER_ADDRESS_HERE' },
  { symbol: 'DOGS', master: 'PUT_DOGS_MASTER_ADDRESS_HERE' },
  { symbol: 'tsTON', master: 'PUT_TSTON_MASTER_ADDRESS_HERE' }
];

export function isVerifiedToken(symbol) {
  return VERIFIED_TOKENS.some(token => token.symbol === symbol);
}
