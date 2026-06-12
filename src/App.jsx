import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// にじみ v5 — 実機ドラッグ問題の修正版(src/App.jsx 差し替え用)
// v4からの修正:
//  1. iOS Safariのスクロール/引っ張り更新がドラッグを乗っ取る問題を修正
//     - ドラッグ中の touchmove を preventDefault(passive: false)
//     - html/body に overscroll-behavior: none / touch-action: none
//  2. ドラッグ監視リスナーを「ドラッグ開始時に1回だけ」登録する方式に変更
//     (旧版は指を動かすたびに貼り直していて、指を離した瞬間の
//      イベントを取りこぼすと操作不能に見える状態が起き得た)
//  3. 盤面の更新計算をReactの状態更新関数の外に出し、
//     スコア加算・効果音・墨処理が二重実行されない構造に変更
// ============================================================

const SIZE = 4;
const GAME_SECONDS = 30;
const SWAP_MS = 120;
const VANISH_MS = 340;
const SCORE_MIX = 5;
const SCORE_SUMI = 30;
const SPAWN_PER_TURN = 2;
const INITIAL_DROPS = 6;

// --- localStorage ---
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* noop */ }
  },
};

// --- 効果音 ---
let audioCtx = null;
const ensureAudio = () => {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
};

const playTone = (freq, duration, { type = "sine", gain = 0.12, when = 0 } = {}) => {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + when;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration);
};

const sfxMix = (combo) => playTone(440 + combo * 70, 0.12, { type: "triangle", gain: 0.1 });
const sfxSumi = () => {
  playTone(160, 0.25, { type: "sine", gain: 0.18 });
  playTone(520, 0.3, { type: "sine", gain: 0.07, when: 0.06 });
};
const sfxEnd = (good) => {
  if (good) {
    playTone(523, 0.15, { gain: 0.1 });
    playTone(659, 0.15, { gain: 0.1, when: 0.12 });
    playTone(784, 0.25, { gain: 0.1, when: 0.24 });
  } else {
    playTone(220, 0.3, { type: "sawtooth", gain: 0.06 });
    playTone(180, 0.4, { type: "sawtooth", gain: 0.06, when: 0.15 });
  }
};

const COLORS = {
  1: { name: "赤", base: "#C73E3A", light: "#E06B5F", fg: "#FFF6EC" },
  2: { name: "青", base: "#2E5C8A", light: "#5C88B5", fg: "#FFF6EC" },
  4: { name: "黄", base: "#E8A325", light: "#F5C45E", fg: "#4A3A12" },
  3: { name: "紫", base: "#7A4988", light: "#A472B0", fg: "#FFF6EC" },
  5: { name: "橙", base: "#D9742B", light: "#EE9C58", fg: "#FFF6EC" },
  6: { name: "緑", base: "#3E7C5B", light: "#6BA888", fg: "#FFF6EC" },
  7: { name: "墨", base: "#26242A", light: "#4A4752", fg: "#F5F0E6" },
};

const BLOB_RADII = {
  1: "58% 42% 55% 45% / 50% 62% 38% 50%",
  2: "45% 55% 48% 52% / 60% 45% 55% 40%",
  4: "52% 48% 60% 40% / 45% 52% 48% 55%",
  3: "55% 45% 42% 58% / 52% 48% 58% 42%",
  5: "48% 52% 55% 45% / 58% 40% 60% 42%",
  6: "42% 58% 50% 50% / 48% 55% 45% 58%",
  7: "50% 50% 48% 52% / 52% 48% 52% 48%",
};

const canMix = (a, b) => (a & b) === 0;

let idCounter = 1;
const makeTile = (value, r, c, isNew = false) => ({
  id: idCounter++, value, r, c, isNew, pop: false, fading: false,
});

const randomEmptyCell = (tiles) => {
  const occupied = new Set(tiles.map(t => `${t.r},${t.c}`));
  const empty = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (!occupied.has(`${r},${c}`)) empty.push([r, c]);
  if (empty.length === 0) return null;
  return empty[Math.floor(Math.random() * empty.length)];
};

const spawnTiles = (tiles, n) => {
  let next = tiles;
  for (let i = 0; i < n; i++) {
    const cell = randomEmptyCell(next);
    if (!cell) break;
    const value = [1, 2, 4][Math.floor(Math.random() * 3)];
    next = [...next, makeTile(value, cell[0], cell[1], true)];
  }
  return next;
};

const initTiles = () => spawnTiles([], INITIAL_DROPS);
const aliveCount = (tiles) => tiles.filter(t => !t.fading).length;

const PAD = 2.6;
const GAP = 2.6;
const CELL = (100 - PAD * 2 - GAP * 3) / 4;
const posPct = (i) => PAD + i * (CELL + GAP);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export default function App() {
  const [phase, setPhase] = useState("ready");
  const [overReason, setOverReason] = useState(null);
  const [tiles, setTiles] = useState(() => initTiles());
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => store.get("nijimi.best", 0));
  const [sumi, setSumi] = useState(0);
  const [combo, setCombo] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_SECONDS);
  const [drag, setDrag] = useState(null); // { id, px, py }
  const [muted, setMuted] = useState(() => store.get("nijimi.muted", false));

  const boardRef = useRef(null);
  const tilesRef = useRef(tiles);           // 最新の盤面を同期的に読むためのミラー
  const dragChanged = useRef(false);
  const lockRef = useRef(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => { tilesRef.current = tiles; }, [tiles]);

  const sfx = useCallback((fn, ...args) => {
    if (!mutedRef.current) fn(...args);
  }, []);

  const playing = phase === "playing";

  // --- タイマー ---
  useEffect(() => {
    if (!playing) return;
    const startedAt = Date.now();
    const iv = setInterval(() => {
      const remain = GAME_SECONDS - (Date.now() - startedAt) / 1000;
      if (remain <= 0) {
        setTimeLeft(0);
        clearInterval(iv);
        endGame("time");
      } else {
        setTimeLeft(remain);
      }
    }, 100);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const endGame = useCallback((reason) => {
    if (phaseRef.current !== "playing") return; // 二重終了防止
    setPhase("over");
    setOverReason(reason);
    setDrag(null);
    setScore(s => {
      setBest(b => {
        const nb = Math.max(b, s);
        store.set("nijimi.best", nb);
        sfx(sfxEnd, s > 0 && s >= b);
        return nb;
      });
      return s;
    });
  }, [sfx]);

  const startGame = () => {
    ensureAudio();
    setTiles(initTiles());
    setScore(0);
    setSumi(0);
    setCombo(0);
    setTimeLeft(GAME_SECONDS);
    setOverReason(null);
    lockRef.current = false;
    setPhase("playing");
  };

  const cellFromPoint = (clientX, clientY) => {
    const rect = boardRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return {
      r: clamp(Math.floor(y / 25), 0, SIZE - 1),
      c: clamp(Math.floor(x / 25), 0, SIZE - 1),
      px: clientX - rect.left,
      py: clientY - rect.top,
    };
  };

  const endTurn = useCallback(() => {
    const solid = tilesRef.current.filter(t => !t.fading).map(t => ({ ...t }));
    const fading = tilesRef.current.filter(t => t.fading);
    const next = [...spawnTiles(solid, SPAWN_PER_TURN), ...fading];
    tilesRef.current = next;
    setTiles(next);
    setCombo(0);
    if (aliveCount(next) >= SIZE * SIZE) {
      setTimeout(() => endGame("full"), 350);
    }
  }, [endGame]);

  const resolveSumi = useCallback((tileId) => {
    lockRef.current = true;
    setTimeout(() => {
      tilesRef.current = tilesRef.current.filter(t => t.id !== tileId);
      setTiles(tilesRef.current);
      lockRef.current = false;
      if (phaseRef.current === "playing") endTurn();
    }, VANISH_MS);
  }, [endTurn]);

  const onPointerDown = (e, tile) => {
    if (!playing || lockRef.current || tile.fading || drag) return;
    e.preventDefault();
    ensureAudio();
    const p = cellFromPoint(e.clientX, e.clientY);
    dragChanged.current = false;
    setCombo(0);
    setDrag({ id: tile.id, px: p.px, py: p.py });
  };

  // --- ドラッグ処理 ---
  // ドラッグ開始時に1回だけリスナー登録(指を動かしても貼り直さない)
  const dragId = drag ? drag.id : null;
  useEffect(() => {
    if (dragId === null) return;

    let pendingPoint = null;
    let raf = 0;

    // 盤面更新の本体。Reactの状態更新関数の外で同期的に計算する
    const applyMove = (p) => {
      const prev = tilesRef.current;
      const me = prev.find(t => t.id === dragId);
      if (!me || me.fading) return;
      if (me.r === p.r && me.c === p.c) return;

      const resident = prev.find(
        t => t.id !== dragId && !t.fading && t.r === p.r && t.c === p.c
      );

      let next;
      if (!resident) {
        next = prev.map(t =>
          t.id === dragId ? { ...t, r: p.r, c: p.c, isNew: false } : t
        );
      } else if (canMix(me.value, resident.value)) {
        const newValue = me.value | resident.value;
        const madeSumi = newValue === 7;
        next = prev
          .filter(t => t.id !== resident.id)
          .map(t =>
            t.id === dragId
              ? { ...t, r: p.r, c: p.c, value: newValue, pop: true, isNew: false,
                  fading: madeSumi }
              : t
          );
        setScore(s => s + (madeSumi ? SCORE_SUMI : SCORE_MIX));
        setCombo(c => {
          sfx(madeSumi ? sfxSumi : sfxMix, c + 1);
          return c + 1;
        });
        if (madeSumi) {
          setSumi(n => n + 1);
          setDrag(null);
          resolveSumi(dragId);
        }
      } else {
        next = prev.map(t => {
          if (t.id === dragId) return { ...t, r: p.r, c: p.c, isNew: false };
          if (t.id === resident.id) return { ...t, r: me.r, c: me.c, isNew: false };
          return t;
        });
      }
      dragChanged.current = true;
      tilesRef.current = next;
      setTiles(next);
    };

    const process = () => {
      raf = 0;
      if (!pendingPoint) return;
      const p = pendingPoint;
      pendingPoint = null;
      setDrag(d => d && { ...d, px: p.px, py: p.py });
      applyMove(p);
    };

    const onMove = (e) => {
      pendingPoint = cellFromPoint(e.clientX, e.clientY);
      if (!raf) raf = requestAnimationFrame(process);
    };

    const onUp = () => {
      setDrag(null);
      if (dragChanged.current) {
        dragChanged.current = false;
        endTurn();
      }
    };

    // iOS Safariのスクロール・引っ張り更新を完全に止める(最重要)
    const preventScroll = (e) => e.preventDefault();

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("touchmove", preventScroll, { passive: false });

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("touchmove", preventScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId, endTurn, resolveSumi, sfx]);

  const toggleMute = () => {
    setMuted(m => {
      store.set("nijimi.muted", !m);
      return !m;
    });
  };

  const timerRatio = timeLeft / GAME_SECONDS;
  const timerColor = timeLeft <= 5 ? "#C73E3A" : timeLeft <= 10 ? "#D9742B" : "#3E7C5B";
  const cellsUsed = aliveCount(tiles);

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      style={{
        minHeight: "100%",
        background: "#F5F0E6",
        backgroundImage:
          "radial-gradient(ellipse at 20% 10%, rgba(199,62,58,0.05), transparent 40%)," +
          "radial-gradient(ellipse at 85% 25%, rgba(46,92,138,0.05), transparent 40%)," +
          "radial-gradient(ellipse at 50% 90%, rgba(232,163,37,0.06), transparent 45%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 16px)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
        paddingLeft: "calc(env(safe-area-inset-left, 0px) + 16px)",
        paddingRight: "calc(env(safe-area-inset-right, 0px) + 16px)",
        fontFamily: "'Hiragino Mincho ProN', 'Yu Mincho', 'MS Mincho', serif",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        overflow: "hidden",
      }}
    >
      <style>{`
        /* スクロール・バウンスの根絶(iOS実機でのドラッグ切れ対策) */
        html, body, #root {
          height: 100%;
          margin: 0;
          overflow: hidden;
          overscroll-behavior: none;
          touch-action: none;
          -webkit-user-select: none;
        }
        @keyframes drop-appear {
          0% { transform: scale(0); opacity: 0; }
          70% { transform: scale(1.1); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes sumi-vanish {
          0% { transform: scale(1); opacity: 1; filter: blur(0); }
          100% { transform: scale(1.7); opacity: 0; filter: blur(7px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .drop { transition: none !important; animation: none !important; }
        }
      `}</style>

      {/* ヘッダー */}
      <div style={{
        width: "min(92vw, 380px)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        marginBottom: 10,
      }}>
        <div>
          <div style={{ color: "#3A3630", fontSize: 32, fontWeight: 700, letterSpacing: 6, lineHeight: 1 }}>
            にじみ
          </div>
          <div style={{ color: "#8B8475", fontSize: 11, marginTop: 6 }}>
            30秒で、どれだけ墨をつくれるか
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <button
            onClick={toggleMute}
            aria-label={muted ? "音を出す" : "音を消す"}
            style={{
              border: "none",
              background: "#FBF8F0",
              borderRadius: 10,
              width: 36,
              height: 36,
              fontSize: 16,
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(58,54,48,0.1)",
            }}
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <ScoreBox label="スコア" value={score} />
          <ScoreBox label="墨" value={sumi} dark />
        </div>
      </div>

      {/* タイマーバー */}
      <div style={{
        width: "min(92vw, 380px)",
        marginBottom: 10,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}>
        <div style={{
          flex: 1,
          height: 8,
          background: "rgba(58,54,48,0.1)",
          borderRadius: 4,
          overflow: "hidden",
        }}>
          <div style={{
            width: `${timerRatio * 100}%`,
            height: "100%",
            background: timerColor,
            borderRadius: 4,
            transition: "width 0.1s linear, background 0.3s ease",
          }} />
        </div>
        <div style={{
          color: timerColor,
          fontSize: 16,
          fontWeight: 700,
          minWidth: 34,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}>
          {Math.ceil(timeLeft)}
        </div>
      </div>

      {/* 盤面 */}
      <div
        ref={boardRef}
        style={{
          position: "relative",
          width: "min(92vw, 380px)",
          aspectRatio: "1",
          background: "#FBF8F0",
          borderRadius: 16,
          boxShadow: "0 4px 24px rgba(58,54,48,0.12), inset 0 0 40px rgba(58,54,48,0.04)",
          touchAction: "none",
        }}
      >
        {Array.from({ length: SIZE * SIZE }).map((_, i) => {
          const r = Math.floor(i / SIZE), c = i % SIZE;
          return (
            <div key={`bg-${i}`} style={{
              position: "absolute",
              top: `${posPct(r)}%`,
              left: `${posPct(c)}%`,
              width: `${CELL}%`,
              height: `${CELL}%`,
              borderRadius: "50%",
              background: "rgba(58,54,48,0.045)",
            }} />
          );
        })}

        {tiles.map((t) => {
          const col = COLORS[t.value];
          const isDragged = drag && drag.id === t.id;
          const base = {
            position: "absolute",
            width: `${CELL}%`,
            height: `${CELL}%`,
            borderRadius: BLOB_RADII[t.value],
            background: `radial-gradient(circle at 35% 32%, ${col.light}, ${col.base} 75%)`,
            color: col.fg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "min(5.6vmin, 22px)",
            fontWeight: 700,
            cursor: "grab",
            touchAction: "none",
            boxShadow: isDragged
              ? `0 8px 20px ${col.base}88`
              : `0 3px 10px ${col.base}55`,
          };

          if (isDragged) {
            return (
              <div key={t.id} className="drop" style={{
                ...base,
                left: drag.px,
                top: drag.py,
                transform: "translate(-50%, -50%) scale(1.15)",
                zIndex: 6,
                transition: "border-radius 0.25s ease, background 0.25s ease",
              }}>
                {col.name}
              </div>
            );
          }

          return (
            <div
              key={t.id}
              className="drop"
              onPointerDown={(e) => onPointerDown(e, t)}
              style={{
                ...base,
                top: `${posPct(t.r)}%`,
                left: `${posPct(t.c)}%`,
                zIndex: t.value === 7 ? 4 : 2,
                transition: `top ${SWAP_MS}ms ease, left ${SWAP_MS}ms ease, border-radius 0.25s ease`,
                animation: t.fading
                  ? `sumi-vanish ${VANISH_MS}ms ease forwards`
                  : t.isNew
                  ? `drop-appear 220ms ease`
                  : "none",
              }}
            >
              {col.name}
            </div>
          );
        })}

        {combo >= 2 && playing && (
          <div style={{
            position: "absolute",
            top: -8,
            right: 0,
            transform: "translateY(-100%)",
            color: "#C73E3A",
            fontSize: 14,
            fontWeight: 700,
          }}>
            {combo} まぜ!
          </div>
        )}

        {phase === "ready" && (
          <Overlay>
            <div style={{ color: "#3A3630", fontSize: 22, fontWeight: 700, letterSpacing: 3 }}>
              30秒タイムアタック
            </div>
            <div style={{ color: "#5C564A", fontSize: 12.5, lineHeight: 2, textAlign: "center" }}>
              水滴をつかんで、なぞって、まぜる<br />
              <Dot v={1} /> 赤・<Dot v={2} /> 青・<Dot v={4} /> 黄 の三色がそろうと<br />
              <Dot v={7} /> 墨になって消える(+{SCORE_SUMI}点)
            </div>
            <div style={{ color: "#A02C33", fontSize: 12, fontWeight: 700 }}>
              盤面がいっぱいになったら、その場で終了!
            </div>
            {best > 0 && (
              <div style={{ color: "#8B8475", fontSize: 12 }}>ベスト: {best}</div>
            )}
            <button onClick={startGame} style={btnStyle()}>はじめる</button>
          </Overlay>
        )}

        {phase === "over" && (
          <Overlay>
            <div style={{ color: "#3A3630", fontSize: 24, fontWeight: 700, letterSpacing: 3 }}>
              {overReason === "full" ? "あふれてしまった…" : "時間切れ!"}
            </div>
            <div style={{ color: "#5C564A", fontSize: 15 }}>
              スコア <b style={{ fontSize: 22 }}>{score}</b> ・ 墨 {sumi} 滴
            </div>
            {score >= best && score > 0 && (
              <div style={{ color: "#D4AF37", fontSize: 13, fontWeight: 700 }}>
                ベスト記録!
              </div>
            )}
            <div style={{ color: "#8B8475", fontSize: 12 }}>ベスト: {best}</div>
            <button onClick={startGame} style={btnStyle()}>もう一度</button>
          </Overlay>
        )}
      </div>

      {/* まぜかたの早見表 */}
      <div style={{
        width: "min(92vw, 380px)",
        display: "flex",
        justifyContent: "center",
        gap: 14,
        marginTop: 14,
        color: "#8B8475",
        fontSize: 11,
        flexWrap: "wrap",
      }}>
        <Rule a={1} b={2} r={3} />
        <Rule a={2} b={4} r={6} />
        <Rule a={1} b={4} r={5} />
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
          赤・青・黄がそろうと <Dot v={7} /> 消える
        </span>
      </div>

      <div style={{
        width: "min(92vw, 380px)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: 10,
      }}>
        <div style={{ color: cellsUsed >= 13 ? "#A02C33" : "#B0A998", fontSize: 11, fontWeight: cellsUsed >= 13 ? 700 : 400 }}>
          盤面 {cellsUsed} / {SIZE * SIZE} — 満杯で終了
        </div>
        {playing && (
          <button onClick={() => endGame("time")} style={btnStyle()}>やめる</button>
        )}
      </div>
    </div>
  );
}

function Overlay({ children }) {
  return (
    <div style={{
      position: "absolute",
      inset: 0,
      borderRadius: 16,
      background: "rgba(251,248,240,0.94)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 14,
      zIndex: 10,
      padding: 16,
    }}>
      {children}
    </div>
  );
}

function Dot({ v }) {
  const col = COLORS[v];
  return (
    <span style={{
      display: "inline-block",
      width: 13,
      height: 13,
      borderRadius: BLOB_RADII[v],
      background: `radial-gradient(circle at 35% 32%, ${col.light}, ${col.base} 75%)`,
      verticalAlign: "middle",
      margin: "0 1px",
    }} />
  );
}

function Rule({ a, b, r }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <Dot v={a} />+<Dot v={b} />=<Dot v={r} />
    </span>
  );
}

function ScoreBox({ label, value, dark }) {
  return (
    <div style={{
      background: dark ? "#26242A" : "#FBF8F0",
      borderRadius: 10,
      padding: "6px 14px",
      textAlign: "center",
      minWidth: 60,
      boxShadow: "0 2px 8px rgba(58,54,48,0.1)",
    }}>
      <div style={{ color: dark ? "#B0A998" : "#8B8475", fontSize: 10, letterSpacing: 2 }}>{label}</div>
      <div style={{ color: dark ? "#F5F0E6" : "#3A3630", fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function btnStyle() {
  return {
    border: "1px solid rgba(58,54,48,0.25)",
    borderRadius: 10,
    padding: "9px 18px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    background: "#3A3630",
    color: "#F5F0E6",
  };
}