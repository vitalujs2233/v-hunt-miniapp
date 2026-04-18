export function calculateNetSpread(buyPrice, sellPrice, capitalTon = 10) {
  const dexFeeBuy = buyPrice * 0.003;
  const dexFeeSell = sellPrice * 0.003;
  const gasCost = 0.05;

  const gross = ((sellPrice - buyPrice) / buyPrice) * 100;

  const serviceFee = Math.max((gross / 100) * capitalTon * 0.15, 0);

  const netProfitTon = Math.max(
    ((sellPrice - buyPrice) * capitalTon) - dexFeeBuy - dexFeeSell - gasCost - serviceFee,
    0
  );

  const netSpreadPercent = capitalTon > 0 ? (netProfitTon / capitalTon) * 100 : 0;

  return {
    grossSpreadPercent: Number(gross.toFixed(2)),
    netSpreadPercent: Number(netSpreadPercent.toFixed(2)),
    estimatedProfitTon: Number(netProfitTon.toFixed(4))
  };
}
