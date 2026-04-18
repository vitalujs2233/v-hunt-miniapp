require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
  })
);

const PORT = process.env.PORT || 3000;
const TONAPI_BASE = process.env.TONAPI_BASE || "https://tonapi.io";
const TONAPI_KEY = process.env.TONAPI_KEY || "";

/**
 * Реальные live quote через STON Omniston
 * ВАЖНО:
 * 1) backend/package.json должен уже содержать "@ston-fi/omniston-sdk"
 * 2) если live quote не придёт — backend автоматически вернёт mock fallback,
 *    чтобы Mini App не ломался
 */
async function getLiveOmnistonDeals() {
  try {
    const sdk = await import("@ston-fi/omniston-sdk");
    const {
      Omniston,
      Blockchain,
      SettlementMethod,
      GaslessSettlement,
    } = sdk;

    const omniston = new Omniston({
      apiUrl: "wss://omni-ws.ston.fi",
    });

    // Текущий live starter:
    // STON / USDT
    // Потом можно добавить NOT / DOGS / другие пары
    const STON_ADDRESS = "EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO";
    const USDT_ADDRESS = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

    const liveDeal = await new Promise((resolve, reject) => {
      let finished = false;

      const subscription = omniston
        .requestForQuote({
          settlementMethods: [SettlementMethod.SETTLEMENT_METHOD_SWAP],
          askAssetAddress: {
            blockchain: Blockchain.TON,
            address: STON_ADDRESS,
          },
          bidAssetAddress: {
            blockchain: Blockchain.TON,
            address: USDT_ADDRESS,
          },
          amount: {
            bidUnits: "1000000", // 1 USDT
          },
          settlementParams: {
            maxPriceSlippageBps: 0,
            gaslessSettlement: GaslessSettlement.GASLESS_SETTLEMENT_POSSIBLE,
            maxOutgoingMessages: 4,
            flexibleReferrerFee: true,
          },
        })
        .subscribe({
          next(event) {
            if (finished) return;

            if (event.type === "quoteUpdated") {
              finished = true;

              try {
                const quote = event.quote || {};
                const askUnits = Number(quote.askUnits || 0);
                const bidUnits = Number(quote.bidUnits || 0);

                // STON ~ 9 decimals, USDT ~ 6 decimals
                const stonAmount = askUnits / 1e9;
                const usdtAmount = bidUnits / 1e6;

                const price = stonAmount > 0 ? usdtAmount / stonAmount : 0;

                resolve({
                  pair: "STON/USDT",
                  buyDex: quote.resolverName || "Omniston",
                  sellDex: "Live Quote",
                  buyPrice: Number(price.toFixed(6)),
                  sellPrice: Number(stonAmount.toFixed(6)),
                  grossSpreadPercent: 0,
                  netSpreadPercent: 0,
                  estimatedProfitTon: 0,
                  verified: true,
                  risk: "live",
                });
              } catch (err) {
                reject(err);
              }

              if (subscription?.unsubscribe) {
                subscription.unsubscribe();
              }
            }

            if (event.type === "noQuote") {
              finished = true;
              reject(new Error("No live quote received"));
              if (subscription?.unsubscribe) {
                subscription.unsubscribe();
              }
            }
          },
          error(err) {
            if (finished) return;
            finished = true;
            reject(err);
          },
        });

      setTimeout(() => {
        if (finished) return;
        finished = true;
        if (subscription?.unsubscribe) {
          subscription.unsubscribe();
        }
        reject(new Error("Quote timeout"));
      }, 8000);
    });

    return [liveDeal];
  } catch (error) {
    console.error("getLiveOmnistonDeals error:", error);
    return [];
  }
}

/**
 * Простой helper для TONAPI
 */
async function tonApiFetch(pathname) {
  const headers = {
    Accept: "application/json",
  };

  if (TONAPI_KEY) {
    headers.Authorization = `Bearer ${TONAPI_KEY}`;
  }

  const response = await fetch(`${TONAPI_BASE}${pathname}`, { headers });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TONAPI ${response.status}: ${text}`);
  }

  return response.json();
}

function toTon(balanceNano) {
  if (balanceNano === null || balanceNano === undefined) return "0";
  const value = Number(balanceNano) / 1e9;
  return value.toFixed(4);
}

function shortenAddress(address) {
  if (!address || typeof address !== "string") return "";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/**
 * Нормализация jettons
 */
function normalizeJettons(payload) {
  const balances = payload?.balances || payload?.jetton_balances || [];
  return balances.map((item) => {
    const balance = item?.balance || "0";
    const meta = item?.jetton || item?.metadata || {};
    const symbol = meta?.symbol || meta?.name || "JETTON";
    const decimals = Number(meta?.decimals ?? 9);

    let normalized = "0";
    try {
      normalized = (Number(balance) / Math.pow(10, decimals)).toFixed(4);
    } catch {
      normalized = "0";
    }

    return {
      symbol,
      name: meta?.name || symbol,
      balance: normalized,
      rawBalance: balance,
      decimals,
      image: meta?.image || meta?.image_url || null,
      address: meta?.address || item?.jetton_address || null,
    };
  });
}

/**
 * Нормализация событий / истории
 */
function normalizeEvents(payload) {
  const events = payload?.events || [];
  return events.slice(0, 10).map((event) => {
    const firstAction = Array.isArray(event.actions) && event.actions.length > 0
      ? event.actions[0]
      : null;

    return {
      eventId: event.event_id || null,
      timestamp: event.timestamp || null,
      isScam: Boolean(event.is_scam),
      type: firstAction?.type || "event",
      status: event.in_progress ? "pending" : "confirmed",
      preview: firstAction?.simple_preview?.name || firstAction?.type || "Transaction",
    };
  });
}

/**
 * Простой helper для fallback scanner deals
 */
function calculateNetSpread(buyPrice, sellPrice, capitalTon = 10) {
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
    estimatedProfitTon: Number(netProfitTon.toFixed(4)),
  };
}

/**
 * GET /
 */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "V-HUNT backend",
    version: "1.1.0",
  });
});

/**
 * GET /api/health
 */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
  });
});

/**
 * GET /api/scanner/live
 *
 * Сначала пробуем реальный live quote через STON Omniston.
 * Если он не пришёл — отдаём fallback deals,
 * чтобы фронт всегда показывал что-то рабочее.
 */
app.get("/api/scanner/live", async (_req, res) => {
  try {
    const liveDeals = await getLiveOmnistonDeals();

    if (Array.isArray(liveDeals) && liveDeals.length > 0) {
      return res.json({
        ok: true,
        source: "omniston-live",
        deals: liveDeals,
      });
    }

    const deals = [
      {
        pair: "TON/USDT",
        buyDex: "STON",
        sellDex: "DeDust",
        buyPrice: 2.14,
        sellPrice: 2.19,
        ...calculateNetSpread(2.14, 2.19, 10),
        verified: true,
        risk: "low",
      },
      {
        pair: "TON/NOT",
        buyDex: "DeDust",
        sellDex: "STON",
        buyPrice: 0.183,
        sellPrice: 0.187,
        ...calculateNetSpread(0.183, 0.187, 10),
        verified: true,
        risk: "medium",
      },
      {
        pair: "TON/DOGS",
        buyDex: "STON",
        sellDex: "DeDust",
        buyPrice: 0.0031,
        sellPrice: 0.0032,
        ...calculateNetSpread(0.0031, 0.0032, 10),
        verified: true,
        risk: "medium",
      },
    ];

    res.json({
      ok: true,
      source: "mock-fallback",
      deals,
    });
  } catch (error) {
    console.error("scanner live error:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "internal server error",
    });
  }
});

/**
 * GET /api/wallet/overview?address=...
 *
 * Возвращает:
 * - address
 * - shortAddress
 * - TON balance
 * - jettons
 * - recent events
 */
app.get("/api/wallet/overview", async (req, res) => {
  try {
    const { address } = req.query;

    if (!address || typeof address !== "string") {
      return res.status(400).json({
        ok: false,
        error: "address query param is required",
      });
    }

    const [accountData, jettonsData, eventsData] = await Promise.all([
      tonApiFetch(`/v2/accounts/${encodeURIComponent(address)}`),
      tonApiFetch(`/v2/accounts/${encodeURIComponent(address)}/jettons`),
      tonApiFetch(`/v2/accounts/${encodeURIComponent(address)}/events?limit=10`),
    ]);

    const result = {
      ok: true,
      address,
      shortAddress: shortenAddress(address),
      tonBalance: toTon(accountData?.balance),
      tonBalanceNano: accountData?.balance || "0",
      status: accountData?.status || "unknown",
      name: accountData?.name || null,
      isWallet: Boolean(accountData?.is_wallet),
      jettons: normalizeJettons(jettonsData),
      recentEvents: normalizeEvents(eventsData),
    };

    res.json(result);
  } catch (error) {
    console.error("wallet overview error:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "internal server error",
    });
  }
});

/**
 * GET /api/wallet/balance?address=...
 * Только баланс TON
 */
app.get("/api/wallet/balance", async (req, res) => {
  try {
    const { address } = req.query;

    if (!address || typeof address !== "string") {
      return res.status(400).json({
        ok: false,
        error: "address query param is required",
      });
    }

    const accountData = await tonApiFetch(`/v2/accounts/${encodeURIComponent(address)}`);

    res.json({
      ok: true,
      address,
      tonBalance: toTon(accountData?.balance),
      tonBalanceNano: accountData?.balance || "0",
      status: accountData?.status || "unknown",
    });
  } catch (error) {
    console.error("wallet balance error:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "internal server error",
    });
  }
});

/**
 * GET /api/wallet/jettons?address=...
 */
app.get("/api/wallet/jettons", async (req, res) => {
  try {
    const { address } = req.query;

    if (!address || typeof address !== "string") {
      return res.status(400).json({
        ok: false,
        error: "address query param is required",
      });
    }

    const jettonsData = await tonApiFetch(`/v2/accounts/${encodeURIComponent(address)}/jettons`);

    res.json({
      ok: true,
      address,
      jettons: normalizeJettons(jettonsData),
    });
  } catch (error) {
    console.error("wallet jettons error:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "internal server error",
    });
  }
});

/**
 * GET /api/wallet/events?address=...
 */
app.get("/api/wallet/events", async (req, res) => {
  try {
    const { address } = req.query;

    if (!address || typeof address !== "string") {
      return res.status(400).json({
        ok: false,
        error: "address query param is required",
      });
    }

    const eventsData = await tonApiFetch(`/v2/accounts/${encodeURIComponent(address)}/events?limit=10`);

    res.json({
      ok: true,
      address,
      recentEvents: normalizeEvents(eventsData),
    });
  } catch (error) {
    console.error("wallet events error:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "internal server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`V-HUNT backend started on port ${PORT}`);
});
// force redeploy 1
