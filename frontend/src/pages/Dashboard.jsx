import { useCallback, useEffect, useRef, useState } from "react";
import AddStockForm from "../components/AddStockForm.jsx";
import WatchlistTable from "../components/WatchlistTable.jsx";
import DigestHeader from "../components/DigestHeader.jsx";
import TrashPanel from "../components/TrashPanel.jsx";
import BriefingModal from "../components/BriefingModal.jsx";
import StockHistoryModal from "../components/StockHistoryModal.jsx";
import ScoreBreakdownModal from "../components/ScoreBreakdownModal.jsx";
import ListSwitcher from "../components/ListSwitcher.jsx";
import SkeletonRows from "../components/SkeletonRows.jsx";
import {
  fetchWatchlist,
  addSymbol,
  removeSymbol,
  streamUrl,
  fetchTrash,
  restoreSymbol,
  markBriefingOpened,
  fetchLists,
  createList,
  renameList,
  deleteList,
  reorderList,
} from "../api.js";

export default function Dashboard() {
  // `items` holds what GET /api/watchlist returned: symbol, note, addedAt,
  // currentPrice (a point-in-time price at load), and sinceLastSeen (the
  // persisted diff against the last time this user checked in — computed
  // and stored server-side, not something the frontend calculates).
  const [items, setItems] = useState([]);
  // `quotesBySymbol` is the live overlay from the SSE stream — it updates
  // the *displayed* price/today's-change continuously, but never touches
  // sinceLastSeen, which is intentionally a fixed snapshot from load time.
  const [quotesBySymbol, setQuotesBySymbol] = useState({});
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removingSymbol, setRemovingSymbol] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [bucketFilter, setBucketFilter] = useState(null); // null | "attention" | "notable" | "quiet"
  const [trashedItems, setTrashedItems] = useState([]);
  const [marketOpen, setMarketOpen] = useState(true);
  const [marketStatusLabel, setMarketStatusLabel] = useState("");
  const [streamStatus, setStreamStatus] = useState("connecting"); // connecting | live | reconnecting
  const [showBriefing, setShowBriefing] = useState(false);
  const briefingShownRef = useRef(false); // ensures the modal auto-opens at most once per page load
  const eventSourceRef = useRef(null);
  const [historySymbol, setHistorySymbol] = useState(null); // which stock's History modal is open, if any
  const [scoreBreakdown, setScoreBreakdown] = useState(null); // { symbol, significance } for the open Score Breakdown modal, if any
  const [lists, setLists] = useState([]);
  const [currentListId, setCurrentListId] = useState("default");

  const loadLists = useCallback(async () => {
    try {
      const { lists: loaded } = await fetchLists();
      setLists(loaded);
    } catch {
      // Non-critical — the switcher just won't show extra lists until the next successful load.
    }
  }, []);

  const loadWatchlist = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { items: loaded, marketOpen: isOpen, marketStatusLabel: label } = await fetchWatchlist(currentListId);
      setItems(loaded);
      setMarketOpen(isOpen);
      setMarketStatusLabel(label);

      // "Since You Were Away": opens automatically once per page load
      // (not on every reload/add/remove within the same session — the
      // ref guards that), so it behaves like a real briefing you
      // dismiss, not a banner that reappears every time the list
      // refreshes.
      if (!briefingShownRef.current && loaded.length > 0) {
        briefingShownRef.current = true;
        setShowBriefing(true);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [currentListId]);

  const loadTrash = useCallback(async () => {
    try {
      const { items: trashed } = await fetchTrash();
      setTrashedItems(trashed);
    } catch {
      // Non-critical for the main page — the trash panel just stays empty/stale until the next successful load.
    }
  }, []);

  useEffect(() => {
    loadWatchlist();
    loadTrash();
    loadLists();
  }, [loadWatchlist, loadTrash, loadLists]);

  // One persistent SSE connection for the life of this page. The backend
  // pushes updates — a real trade (live) or a simulated tick (fallback)
  // — the instant it has them, instead of the browser polling on a timer.
  useEffect(() => {
    const es = new EventSource(streamUrl());
    eventSourceRef.current = es;

    es.addEventListener("open", () => setStreamStatus("live"));

    es.addEventListener("snapshot", (event) => {
      const quotes = JSON.parse(event.data);
      const map = {};
      quotes.forEach((q) => (map[q.symbol] = q));
      setQuotesBySymbol(map);
      setStreamStatus("live");
    });

    es.addEventListener("quote", (event) => {
      const quote = JSON.parse(event.data);
      setQuotesBySymbol((prev) => ({ ...prev, [quote.symbol]: quote }));
      setStreamStatus("live");
    });

    // Cross-device: if this same user acknowledges a flag on ANOTHER
    // device, this connection hears about it immediately over the same
    // stream — no reload needed to clear the "new" indicator here too.
    es.addEventListener("reviewed", (event) => {
      const { symbol } = JSON.parse(event.data);
      setItems((prev) => prev.map((i) => (i.symbol === symbol ? { ...i, isNewSignificance: false } : i)));
    });

    es.onerror = () => setStreamStatus("reconnecting");

    return () => es.close();
  }, []);

  async function handleAdd(symbol, note) {
    setAdding(true);
    try {
      await addSymbol(symbol, note, currentListId);
      await loadWatchlist();
    } finally {
      setAdding(false);
    }
  }

  function handleSwitchList(listId) {
    setCurrentListId(listId);
  }

  async function handleCreateList(name) {
    const { list } = await createList(name);
    await loadLists();
    setCurrentListId(list.id);
  }

  async function handleRenameList(listId, name) {
    await renameList(listId, name);
    await loadLists();
  }

  async function handleDeleteList(listId) {
    try {
      await deleteList(listId);
      if (listId === currentListId) {
        setCurrentListId("default");
      }
      await loadLists();
      await loadTrash(); // deleted list's items land in Trash
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleReorderList(listId, direction) {
    const { lists: reordered } = await reorderList(listId, direction);
    setLists(reordered);
  }

  async function handleRemove(symbol) {
    setRemovingSymbol(symbol);
    try {
      await removeSymbol(symbol);
      setItems((prev) => prev.filter((i) => i.symbol !== symbol));
      setQuotesBySymbol((prev) => {
        const next = { ...prev };
        delete next[symbol];
        return next;
      });
      await loadTrash(); // it's now recoverable — reflect that immediately
    } catch (err) {
      setError(err.message);
    } finally {
      setRemovingSymbol(null);
    }
  }

  async function handleRestore(symbol) {
    await restoreSymbol(symbol);
    setTrashedItems((prev) => prev.filter((i) => i.symbol !== symbol));
    await loadWatchlist();
  }

  // Optimistic update: clear the "new" flag immediately rather than
  // waiting for the next full reload, since the server write already
  // succeeded by the time this fires.
  function handleReviewed(symbol) {
    setItems((prev) => prev.map((i) => (i.symbol === symbol ? { ...i, isNewSignificance: false } : i)));
  }

  async function handleDismissBriefing() {
    setShowBriefing(false);
    try {
      await markBriefingOpened();
    } catch {
      // Non-critical — worst case the server-side anchor just doesn't advance this once.
    }
  }

  const filteredItems = items
    .filter((i) =>
      search.trim()
        ? i.symbol.toLowerCase().includes(search.trim().toLowerCase()) ||
          (i.note || "").toLowerCase().includes(search.trim().toLowerCase())
        : true
    )
    .filter((i) => (bucketFilter ? i.significance?.bucket === bucketFilter : true));

  const statusLabel = {
    connecting: { text: "Connecting...", className: "stream-status connecting" },
    live: { text: "● Live", className: "stream-status live" },
    reconnecting: { text: "Reconnecting...", className: "stream-status reconnecting" },
  }[streamStatus];

  return (
    <div className="page">
      {showBriefing && (
        <BriefingModal
          items={items}
          quotesBySymbol={quotesBySymbol}
          onDismiss={handleDismissBriefing}
          onOpenHistory={() => {
            setShowBriefing(false);
            /* the Trash/History panel is already visible on the main page below */
          }}
        />
      )}
      {historySymbol && <StockHistoryModal symbol={historySymbol} onClose={() => setHistorySymbol(null)} />}
      {scoreBreakdown && (
        <ScoreBreakdownModal
          symbol={scoreBreakdown.symbol}
          significance={scoreBreakdown.significance}
          onClose={() => setScoreBreakdown(null)}
        />
      )}

      <header>
        <div className="header-row">
          <h1>Dashboard</h1>
          <span className={statusLabel.className}>{statusLabel.text}</span>
          {marketStatusLabel && (
            <span className={`market-status ${marketOpen ? "market-open" : "market-closed"}`}>
              {marketStatusLabel}
            </span>
          )}
        </div>
        <p className="tagline">Real-time prices, plus what's changed since you last checked.</p>
      </header>

      <p className="adding-to-label">
        Adding to: <strong>{lists.find((l) => l.id === currentListId)?.name || "My Watchlist"}</strong>
      </p>
      <AddStockForm onAdd={handleAdd} isSubmitting={adding} />

      {error && <div className="error-banner">{error}</div>}

      <ListSwitcher
        lists={lists}
        currentListId={currentListId}
        onSwitch={handleSwitchList}
        onCreate={handleCreateList}
        onRename={handleRenameList}
        onDelete={handleDeleteList}
        onReorder={handleReorderList}
      />

      <DigestHeader items={items} activeBucket={bucketFilter} onSelectBucket={setBucketFilter} />

      {items.length > 0 && (
        <input
          type="text"
          className="search-input"
          placeholder="Search your watchlist..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {loading ? (
        <SkeletonRows count={4} />
      ) : (
        <WatchlistTable
          items={filteredItems}
          quotesBySymbol={quotesBySymbol}
          onRemove={handleRemove}
          removingSymbol={removingSymbol}
          onReviewed={handleReviewed}
          marketOpen={marketOpen}
          onShowHistory={setHistorySymbol}
          onShowScoreBreakdown={(symbol, significance) => setScoreBreakdown({ symbol, significance })}
          emptyMessage={
            search.trim()
              ? `No matches for "${search.trim()}".`
              : bucketFilter
              ? `No stocks in this category right now.`
              : undefined
          }
        />
      )}

      <TrashPanel trashedItems={trashedItems} onRestore={handleRestore} />

      <footer>
        <p className="muted">
          Prices push instantly over a live connection. "Since last check" compares against the price
          the last time you loaded this page (30+ minutes ago) — not against today's ticking price.
        </p>
      </footer>
    </div>
  );
}
