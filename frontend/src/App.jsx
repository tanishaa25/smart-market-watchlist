import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import NavBar from "./components/NavBar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import BrowseStocks from "./pages/BrowseStocks.jsx";
import StockDetails from "./pages/StockDetails.jsx";
import AuthPage from "./pages/AuthPage.jsx";
import { getToken, getStoredEmail, logout, setUnauthorizedHandler, startAnonymousSession } from "./api.js";

export default function App() {
  // null = still deciding (checking for a token / starting an anonymous
  // session); { email: "" } = an anonymous session; { email: "x@y.com" }
  // = a real upgraded account. Anonymous-first: nobody sees a login wall
  // — a session is created silently the moment the app loads with none.
  const [session, setSession] = useState(() => {
    const token = getToken();
    return token ? { email: getStoredEmail() } : undefined; // undefined = "haven't checked yet"
  });
  const [showManualAuth, setShowManualAuth] = useState(false);

  useEffect(() => {
    if (session === undefined) {
      startAnonymousSession()
        .then(() => setSession({ email: "" }))
        .catch(() => setShowManualAuth(true)); // if even an anonymous session fails, fall back to the manual form
    }
  }, [session]);

  // If any protected call comes back 401 (expired/invalid token), drop
  // back to the login screen instead of leaving the UI stuck showing
  // stale data behind a wall of failed requests.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout();
      setSession(undefined);
    });
  }, []);

  function handleAuthed(user) {
    setSession({ email: user.email });
    setShowManualAuth(false);
  }

  function handleLogout() {
    logout();
    setSession(undefined);
  }

  if (showManualAuth) {
    return <AuthPage onAuthed={handleAuthed} />;
  }

  if (!session) {
    return null; // brief moment while the anonymous session is being created
  }

  return (
    <div className="app">
      <NavBar email={session.email} onLogout={handleLogout} onAuthed={handleAuthed} />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/browse" element={<BrowseStocks />} />
        <Route path="/stock/:symbol" element={<StockDetails />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
