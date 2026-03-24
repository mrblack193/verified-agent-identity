const SYMBOLS = {
  BTCUSD: "XXBTZUSD",
  ETHUSD: "XETHZUSD",
  XAUTUSD: "XAUTZUSD",
};

const TIMEFRAMES = {
  "1H": 60,
  "4H": 240,
  "1D": 1440,
};

const statusEl = document.getElementById("status");
const assetSelect = document.getElementById("assetSelect");
const refreshBtn = document.getElementById("refreshBtn");
const strategyCards = document.getElementById("strategyCards");

refreshBtn.addEventListener("click", () => loadDashboard(assetSelect.value));
assetSelect.addEventListener("change", () => loadDashboard(assetSelect.value));

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  values.forEach((v, i) => {
    if (i === 0) {
      out.push(v);
      return;
    }
    prev = v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

function sma(values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const chunk = values.slice(i - period + 1, i + 1);
    out[i] = chunk.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

function macd(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const line = values.map((_, i) => ema12[i] - ema26[i]);
  const signal = ema(line, 9);
  const hist = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
}

function stochastic(highs, lows, closes, period = 14, smooth = 3) {
  const k = Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i += 1) {
    const highest = Math.max(...highs.slice(i - period + 1, i + 1));
    const lowest = Math.min(...lows.slice(i - period + 1, i + 1));
    const denom = highest - lowest;
    k[i] = denom === 0 ? 50 : ((closes[i] - lowest) / denom) * 100;
  }

  const d = sma(k.map((x) => x ?? 50), smooth);
  return { k, d };
}

async function fetchOHLC(krakenPair, intervalMinutes, limit = 220) {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=${intervalMinutes}`;
  const res = await fetch(url);
  const json = await res.json();

  if (json.error && json.error.length) {
    throw new Error(json.error.join(", "));
  }

  const resultKey = Object.keys(json.result).find((k) => k !== "last");
  const rows = json.result[resultKey].slice(-limit);

  return rows.map((r) => ({
    time: new Date(Number(r[0]) * 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[6]),
  }));
}

function evaluateStrategy(tf, data, indicators) {
  const last = data[data.length - 1];
  const rsiLast = indicators.rsi.at(-1);
  const ma34Last = indicators.ma34.at(-1);
  const ma89Last = indicators.ma89.at(-1);
  const macdHistLast = indicators.macd.hist.at(-1);
  const kLast = indicators.stoch.k.at(-1);
  const dLast = indicators.stoch.d.at(-1);

  const trendBull = last.close > ma34Last && ma34Last > ma89Last;
  const trendBear = last.close < ma34Last && ma34Last < ma89Last;

  let scoreLong = 0;
  let scoreShort = 0;

  if (trendBull) scoreLong += 2;
  if (trendBear) scoreShort += 2;
  if (rsiLast > 55) scoreLong += 1;
  if (rsiLast < 45) scoreShort += 1;
  if (macdHistLast > 0) scoreLong += 1;
  if (macdHistLast < 0) scoreShort += 1;
  if (kLast > dLast && kLast < 80) scoreLong += 1;
  if (kLast < dLast && kLast > 20) scoreShort += 1;

  let action = "WAIT";
  let confidence = Math.max(scoreLong, scoreShort);

  if (scoreLong >= 4 && scoreLong > scoreShort) action = "LONG";
  else if (scoreShort >= 4 && scoreShort > scoreLong) action = "SHORT";

  const hold = estimateHoldDuration(tf, action, confidence);

  return {
    tf,
    action,
    confidence,
    hold,
    snapshot: {
      close: last.close,
      rsi: rsiLast,
      ma34: ma34Last,
      ma89: ma89Last,
      macdHist: macdHistLast,
      stochK: kLast,
      stochD: dLast,
    },
  };
}

function estimateHoldDuration(tf, action, confidence) {
  if (action === "WAIT") {
    return "Chờ xác nhận thêm 2-4 nến trước khi vào lệnh.";
  }

  const ranges = {
    "1H": confidence >= 5 ? "6-18 giờ" : "3-10 giờ",
    "4H": confidence >= 5 ? "1-4 ngày" : "12-36 giờ",
    "1D": confidence >= 5 ? "4-15 ngày" : "2-7 ngày",
  };

  return `Thời gian giữ lệnh dự kiến: ${ranges[tf]}.`;
}

function renderStrategyCards(results, symbol) {
  strategyCards.innerHTML = "";

  results.forEach((res) => {
    const card = document.createElement("div");
    card.className = "card";

    const tag = document.createElement("span");
    const cls = res.action === "LONG" ? "long" : res.action === "SHORT" ? "short" : "wait";
    tag.className = `tag ${cls}`;
    tag.textContent = `${symbol} ${res.tf}: ${res.action}`;

    card.appendChild(tag);
    card.innerHTML += `
      <p>Độ mạnh tín hiệu: <strong>${res.confidence}/6</strong></p>
      <p>Giá hiện tại: <strong>${res.snapshot.close.toFixed(2)}</strong></p>
      <p>RSI: ${res.snapshot.rsi.toFixed(2)} | MACD hist: ${res.snapshot.macdHist.toFixed(4)}</p>
      <p>Stoch K/D: ${res.snapshot.stochK.toFixed(2)} / ${res.snapshot.stochD.toFixed(2)}</p>
      <p><strong>${res.hold}</strong></p>
    `;

    strategyCards.appendChild(card);
  });
}

function renderCharts(data, indicators, symbol, tfLabel) {
  const t = data.map((x) => x.time);

  Plotly.newPlot(
    "priceChart",
    [
      {
        x: t,
        open: data.map((x) => x.open),
        high: data.map((x) => x.high),
        low: data.map((x) => x.low),
        close: data.map((x) => x.close),
        type: "candlestick",
        name: `${symbol} ${tfLabel}`,
      },
      { x: t, y: indicators.ma34, type: "scatter", mode: "lines", name: "MA34" },
      { x: t, y: indicators.ma89, type: "scatter", mode: "lines", name: "MA89" },
    ],
    {
      paper_bgcolor: "#111a2c",
      plot_bgcolor: "#111a2c",
      font: { color: "#d8e2ff" },
      margin: { t: 20, r: 10, l: 40, b: 40 },
      xaxis: { rangeslider: { visible: false } },
      yaxis: { title: "Giá" },
    },
    { responsive: true }
  );

  Plotly.newPlot(
    "rsiChart",
    [
      { x: t, y: indicators.rsi, type: "scatter", mode: "lines", name: "RSI" },
      { x: [t[0], t.at(-1)], y: [70, 70], type: "scatter", mode: "lines", name: "Overbought" },
      { x: [t[0], t.at(-1)], y: [30, 30], type: "scatter", mode: "lines", name: "Oversold" },
    ],
    {
      paper_bgcolor: "#111a2c",
      plot_bgcolor: "#111a2c",
      font: { color: "#d8e2ff" },
      margin: { t: 20, r: 10, l: 40, b: 40 },
      yaxis: { range: [0, 100] },
    },
    { responsive: true }
  );

  Plotly.newPlot(
    "macdChart",
    [
      { x: t, y: indicators.macd.line, type: "scatter", mode: "lines", name: "MACD" },
      { x: t, y: indicators.macd.signal, type: "scatter", mode: "lines", name: "Signal" },
      { x: t, y: indicators.macd.hist, type: "bar", name: "Histogram" },
    ],
    {
      paper_bgcolor: "#111a2c",
      plot_bgcolor: "#111a2c",
      font: { color: "#d8e2ff" },
      margin: { t: 20, r: 10, l: 40, b: 40 },
    },
    { responsive: true }
  );

  Plotly.newPlot(
    "stochChart",
    [
      { x: t, y: indicators.stoch.k, type: "scatter", mode: "lines", name: "%K" },
      { x: t, y: indicators.stoch.d, type: "scatter", mode: "lines", name: "%D" },
      { x: [t[0], t.at(-1)], y: [80, 80], type: "scatter", mode: "lines", name: "OB" },
      { x: [t[0], t.at(-1)], y: [20, 20], type: "scatter", mode: "lines", name: "OS" },
    ],
    {
      paper_bgcolor: "#111a2c",
      plot_bgcolor: "#111a2c",
      font: { color: "#d8e2ff" },
      margin: { t: 20, r: 10, l: 40, b: 40 },
      yaxis: { range: [0, 100] },
    },
    { responsive: true }
  );
}

async function loadDashboard(symbol) {
  const pair = SYMBOLS[symbol];
  statusEl.textContent = `Đang tải dữ liệu ${symbol}...`;

  try {
    const [data1h, data4h, data1d] = await Promise.all([
      fetchOHLC(pair, TIMEFRAMES["1H"]),
      fetchOHLC(pair, TIMEFRAMES["4H"]),
      fetchOHLC(pair, TIMEFRAMES["1D"]),
    ]);

    const buildIndicators = (series) => {
      const closes = series.map((x) => x.close);
      return {
        ma34: sma(closes, 34),
        ma89: sma(closes, 89),
        rsi: rsi(closes, 14),
        macd: macd(closes),
        stoch: stochastic(
          series.map((x) => x.high),
          series.map((x) => x.low),
          closes,
          14,
          3
        ),
      };
    };

    const i1h = buildIndicators(data1h);
    const i4h = buildIndicators(data4h);
    const i1d = buildIndicators(data1d);

    renderCharts(data1h, i1h, symbol, "1H");

    const strategies = [
      evaluateStrategy("1H", data1h, i1h),
      evaluateStrategy("4H", data4h, i4h),
      evaluateStrategy("1D", data1d, i1d),
    ];

    renderStrategyCards(strategies, symbol);
    statusEl.textContent = `Đã cập nhật ${symbol} lúc ${new Date().toLocaleString("vi-VN")}.`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Lỗi tải dữ liệu: ${err.message}`;
  }
}

loadDashboard(assetSelect.value);
