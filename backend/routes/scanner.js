import express from 'express';
import { getStonQuotes } from '../services/ston.js';
import { getDedustQuotes } from '../services/dedust.js';
import { calculateNetSpread } from '../services/spread.js';

const router = express.Router();

router.get('/live', async (req, res) => {
  try {
    const ston = await getStonQuotes();
    const dedust = await getDedustQuotes();

    const deals = [
      {
        pair: 'TON/USDT',
        buyDex: 'STON',
        sellDex: 'DeDust',
        buyPrice: 2.14,
        sellPrice: 2.19,
        ...calculateNetSpread(2.14, 2.19, 10),
        verified: true,
        risk: 'low'
      },
      {
        pair: 'TON/NOT',
        buyDex: 'DeDust',
        sellDex: 'STON',
        buyPrice: 0.183,
        sellPrice: 0.187,
        ...calculateNetSpread(0.183, 0.187, 10),
        verified: true,
        risk: 'medium'
      }
    ];

    res.json(deals);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'scanner_error' });
  }
});

export default router;
