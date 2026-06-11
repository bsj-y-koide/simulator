// ===== ポジション管理 =====
var positions   = [];
var posId       = 0;
var realizedPnL = 0; // 確定済み損益
var sessionStartIdx = 0; // セッション開始時のバーインデックス
var sessionId = Date.now(); // セッション識別子
var tradeHistory = []; // このセッションの全トレード履歴

const HALF_SPREAD = 0.2; // 2pips = $0.20（片側）、合計4pips
function getLot() { return parseFloat(document.getElementById('lot').value); }

document.getElementById('btn-buy').addEventListener('click', () => {
  const mid = livePrice || bars1m[curIdx1m].c;
  const price = mid + HALF_SPREAD; // Askで約定
  const entryTime = new Date(bars1m[curIdx1m].t * 1000).toISOString();
  positions.push({ id: ++posId, type: 'BUY', price, lot: getLot(), entryTime, entryIdx: curIdx1m });
  updatePnL(mid);
});
document.getElementById('btn-sell').addEventListener('click', () => {
  const mid = livePrice || bars1m[curIdx1m].c;
  const price = mid - HALF_SPREAD; // Bidで約定
  const entryTime = new Date(bars1m[curIdx1m].t * 1000).toISOString();
  positions.push({ id: ++posId, type: 'SELL', price, lot: getLot(), entryTime, entryIdx: curIdx1m });
  updatePnL(mid);
});
document.getElementById('btn-close').addEventListener('click', () => {
  const mid = livePrice || bars1m[curIdx1m].c;
  const closeTime = new Date(bars1m[curIdx1m].t * 1000).toISOString();
  // 全ポジションを決済して確定損益に加算 + DB保存
  for (const p of positions) {
    const cur = p.type === 'BUY' ? mid - HALF_SPREAD : mid + HALF_SPREAD; // BUY→Bidで決済、SELL→Askで決済
    const diff = p.type === 'BUY' ? cur - p.price : p.price - cur;
    const pnlUsd = diff * p.lot * 100;
    realizedPnL += pnlUsd;
    const trade = {
      sessionId, type: p.type, lot: p.lot,
      entryPrice: p.price, closePrice: cur,
      entryTime: p.entryTime, closeTime,
      entryIdx: p.entryIdx, closeIdx: curIdx1m,
      pnlUsd, pnlJpy: Math.round(pnlUsd * JPY_RATE),
      pips: Math.round(diff * 10) / 10,
      holdBars: curIdx1m - p.entryIdx
    };
    tradeHistory.push(trade);
    if (db) dbAdd('trades', trade);
  }
  // セッション情報を更新
  if (db) {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const getReq = store.get(sessionId);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      store.put({
        ...existing, id: sessionId, startIdx: sessionStartIdx,
        startDate: new Date(bars1m[sessionStartIdx].t * 1000).toISOString(),
        startPrice: bars1m[sessionStartIdx].c,
        trades: tradeHistory.length,
        totalPnL: realizedPnL,
        totalPnLJpy: Math.round(realizedPnL * JPY_RATE),
        drawings: {
          fibo: fiboSaved.map(f => ({ p1:f.p1, p2:f.p2, t1:f.t1, t2:f.t2 })),
          hline: hlineSaved.map(h => ({ price:h.price })),
          tline: tlineSaved.map(f => ({ p1:f.p1, p2:f.p2, t1:f.t1, t2:f.t2 }))
        }
      });
    };
  }
  positions = [];
  updatePnL(cur);
});

function calcFloat(mid) {
  let f = 0;
  for (const p of positions) {
    const cur = p.type === 'BUY' ? mid - HALF_SPREAD : mid + HALF_SPREAD;
    const diff = p.type === 'BUY' ? cur - p.price : p.price - cur;
    f += diff * p.lot * 100;
  }
  return f;
}

const JPY_RATE = 160;
function fmtJpy(v) {
  const jpy = v * JPY_RATE;
  return `${jpy >= 0 ? '+' : ''}${Math.round(jpy).toLocaleString()}円`;
}
function fmtUsd(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}$`; }

function updatePnL(cur) {
  const floatPnL = calcFloat(cur);
  const totalPnL = realizedPnL + floatPnL;

  const fe = document.getElementById('pnl-float');
  fe.textContent = `含み: ${fmtJpy(floatPnL)}`;
  fe.style.color  = floatPnL >= 0 ? '#26a69a' : '#ef5350';

  const te = document.getElementById('pnl-total');
  te.textContent = `確定+含み: ${fmtJpy(totalPnL)}`;
  te.style.color  = totalPnL >= 0 ? '#26a69a' : '#ef5350';

  updatePosDisplay(cur);
}

function updatePosDisplay(cur) {
  const el = document.getElementById('positions');
  const info = document.getElementById('pos-info');
  if (positions.length === 0) {
    el.innerHTML = `<span style="color:#666">ポジションなし</span>　<span style="color:#aaa">確定: ${fmtJpy(realizedPnL)}</span>`;
    info.textContent = '';
    return;
  }
  el.innerHTML = positions.map(p => {
    const diff = p.type === 'BUY' ? cur - p.price : p.price - cur;
    const pnl  = diff * p.lot * 100;
    return `<span style="color:${pnl>=0?'#26a69a':'#ef5350'}">[${p.id}] ${p.type} ${p.lot} @ ${p.price.toFixed(2)} → ${fmtJpy(pnl)}</span>`;
  }).join('  ') + `　<span style="color:#aaa;font-size:11px">確定累計: ${fmtJpy(realizedPnL)}</span>`;
  info.textContent = `${positions.length}件`;
}

// Bid/Ask価格ラベル（Y軸右側のみ）
function drawBidAskLines() {
  const mid = livePrice || bars1m[curIdx1m]?.c || 0;
  if (mid === 0) return;
  const bid = mid - HALF_SPREAD;
  const ask = mid + HALF_SPREAD;
  const w = chartDiv.clientWidth;

  const bidY = priceToY(bid);
  const askY = priceToY(ask);

  [{ price: bid, color: '#ef5350', y: bidY },
   { price: ask, color: '#26a69a', y: askY }].forEach(({ price, color, y }) => {
    if (y === null || y < 0 || y > chartDiv.clientHeight) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.restore();
  });

  // ラベル（重ならないよう調整）
  if (bidY !== null && askY !== null) {
    ctx.save();
    ctx.font = 'bold 10px monospace';
    const lblH = 12;
    let by = bidY, ay = askY;
    // 近すぎる場合は上下にずらす
    if (Math.abs(by - ay) < lblH + 2) {
      const mid2 = (by + ay) / 2;
      ay = mid2 - lblH / 2 - 1;
      by = mid2 + lblH / 2 + 1;
    }
    [{ price: bid, color: '#ef5350', y: by },
     { price: ask, color: '#26a69a', y: ay }].forEach(({ price, color, y }) => {
      const label = price.toFixed(2);
      const tw = ctx.measureText(label).width;
      const lx = w - tw - 4;
      ctx.fillStyle = color;
      ctx.fillRect(lx - 2, y - 6, tw + 4, lblH);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx, y + 3);
    });
    ctx.restore();
  }
}

function drawTradeMarkers() {
  if (tradeHistory.length === 0) return;
  tradeHistory.forEach(t => {
    const entryX = timeToX(t.entryTime ? new Date(t.entryTime).getTime() : null);
    const closeX = timeToX(t.closeTime ? new Date(t.closeTime).getTime() : null);
    const entryY = priceToY(t.entryPrice);
    const closeY = priceToY(t.closePrice);
    const isBuy = t.type === 'BUY';
    const profit = t.pnlUsd >= 0;

    // エントリー→決済の接続線
    if (entryX !== null && closeX !== null && entryY !== null && closeY !== null) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = profit ? '#26a69a' : '#ef5350';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(entryX, entryY);
      ctx.lineTo(closeX, closeY);
      ctx.stroke();
      ctx.restore();
    }

    // エントリーマーカー（▲/▼）
    if (entryX !== null && entryY !== null) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = isBuy ? '#1565c0' : '#b71c1c';
      ctx.beginPath();
      if (isBuy) {
        ctx.moveTo(entryX, entryY + 6);
        ctx.lineTo(entryX - 5, entryY + 14);
        ctx.lineTo(entryX + 5, entryY + 14);
      } else {
        ctx.moveTo(entryX, entryY - 6);
        ctx.lineTo(entryX - 5, entryY - 14);
        ctx.lineTo(entryX + 5, entryY - 14);
      }
      ctx.fill();
      ctx.restore();
    }

    // 決済マーカー（×）
    if (closeX !== null && closeY !== null) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = profit ? '#26a69a' : '#ef5350';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(closeX - 5, closeY - 5);
      ctx.lineTo(closeX + 5, closeY + 5);
      ctx.moveTo(closeX + 5, closeY - 5);
      ctx.lineTo(closeX - 5, closeY + 5);
      ctx.stroke();
      // 損益ラベル
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = profit ? '#26a69a' : '#ef5350';
      ctx.fillText(fmtJpy(t.pnlUsd), closeX + 8, closeY + 4);
      ctx.restore();
    }
  });
}

function drawPositionLines() {
  if (positions.length === 0) return;
  const cur = livePrice || bars1m[curIdx1m]?.c || 0;
  positions.forEach(p => {
    const y = priceToY(p.price);
    if (y === null || y < 0 || y > fiboCanvas.height) return;
    const isBuy = p.type === 'BUY';
    const diff  = isBuy ? cur - p.price : p.price - cur;
    const profit = diff >= 0;
    ctx.save();
    ctx.strokeStyle = isBuy ? '#42a5f5' : '#ef5350';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(fiboCanvas.width, y);
    ctx.stroke();
    // ラベル
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.font = 'bold 11px monospace';
    const pnl  = diff * p.lot * 100;
    const label = `${p.type}  ${fmtJpy(pnl)}`;
    ctx.font = 'bold 12px monospace';
    const tw = ctx.measureText(label).width;
    const lx = (chartDiv.clientWidth - tw) / 2 - 4;
    ctx.fillStyle = profit ? '#1b5e20cc' : '#b71c1ccc';
    ctx.fillRect(lx, y - 15, tw + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 4, y - 3);
    ctx.restore();
  });
}
