async function getLiveOmnistonDeals() {
  try {
    const sdk = await import("@ston-fi/omniston-sdk");
    const {
      Omniston,
      Blockchain,
      SettlementMethod,
      GaslessSettlement
    } = sdk;

    const omniston = new Omniston({
      apiUrl: "wss://omni-ws.ston.fi"
    });

    // Официальные примерные адреса из документации STON Omniston Node.js:
    // STON
    const STON_ADDRESS = "EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO";
    // USDT
    const USDT_ADDRESS = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

    const deal = await new Promise((resolve, reject) => {
      let done = false;

      const subscription = omniston.requestForQuote({
        settlementMethods: [SettlementMethod.SETTLEMENT_METHOD_SWAP],
        askAssetAddress: {
          blockchain: Blockchain.TON,
          address: STON_ADDRESS
        },
        bidAssetAddress: {
          blockchain: Blockchain.TON,
          address: USDT_ADDRESS
        },
        amount: {
          bidUnits: "1000000" // 1 USDT
        },
        settlementParams: {
          maxPriceSlippageBps: 0,
          gaslessSettlement: GaslessSettlement.GASLESS_SETTLEMENT_POSSIBLE,
          maxOutgoingMessages: 4,
          flexibleReferrerFee: true
        }
      }).subscribe({
        next(event) {
          if (done) return;

          if (event.type === "quoteUpdated") {
            done = true;

            try {
              const quote = event.quote;

              const askUnits = Number(quote.askUnits || 0);
              const bidUnits = Number(quote.bidUnits || 0);

              // Для STON примем 9 decimals, для USDT 6 decimals
              const stonAmount = askUnits / 1e9;
              const usdtAmount = bidUnits / 1e6;

              const stonPriceInUsdt = stonAmount > 0
                ? usdtAmount / stonAmount
                : 0;

              resolve({
                pair: "STON/USDT",
                buyDex: quote.resolverName || "Omniston",
                sellDex: "Live Quote",
                buyPrice: Number(stonPriceInUsdt.toFixed(6)),
                sellPrice: Number(stonAmount.toFixed(6)),
                grossSpreadPercent: 0,
                netSpreadPercent: 0,
                estimatedProfitTon: 0,
                verified: true,
                risk: "live"
              });
            } catch (err) {
              reject(err);
            }

            if (subscription?.unsubscribe) {
              subscription.unsubscribe();
            }
          }

          if (event.type === "noQuote") {
            done = true;
            reject(new Error("No live quote received"));
            if (subscription?.unsubscribe) {
              subscription.unsubscribe();
            }
          }
        },
        error(err) {
          if (done) return;
          done = true;
          reject(err);
        }
      });

      setTimeout(() => {
        if (done) return;
        done = true;
        if (subscription?.unsubscribe) {
          subscription.unsubscribe();
        }
        reject(new Error("Quote timeout"));
      }, 8000);
    });

    return [deal];
  } catch (error) {
    console.error("getLiveOmnistonDeals error:", error);
    return [];
  }
}

module.exports = { getLiveOmnistonDeals };
