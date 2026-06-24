import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Derive the router basename from where this app is mounted so deep links work
// both under /apps/<id>/ on the hub and at a custom-domain root. The hub's SPA
// fallback serves index.html for unknown routes; the router takes it from there.
function basename(): string {
  const m = location.pathname.match(/^(\/apps\/[^/]+)\//);
  return m ? m[1] : "/";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename()}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
