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
 * ДОБАВЛЕНО:
 * Простой helper для тестовых scanner deals
 * ЭТО ПОКА ВРЕМЕННЫЕ ДАННЫЕ, ЧТОБЫ /api/scanner/live РАБОТАЛ
 * ПОТОМ МЫ ЗАМЕНИМ ИХ НА РЕАЛЬНЫЕ ЦЕНЫ С БИРЖ
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
    version: "1.0.0",
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
 * ДОБАВЛЕНО:
 * GET /api/scanner/live
 *
 * ЭТО НУЖНО ДЛЯ RAILWAY И MINI APP,
 * ЧТОБЫ ЭНДПОИНТ РАБОТАЛ И ВО ФРОНТЕ МОЖНО БЫЛО ПОЛУЧАТЬ СДЕЛКИ
 *
 * ПОКА ТУТ ТЕСТОВЫЕ ДАННЫЕ
 * ПОТОМ МЫ ЗАМЕНИМ ИХ НА STON + DEDUST
 */
app.get("/api/scanner/live", async (_req, res) => {
  try {
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
      source: "mock-scanner-data",
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
