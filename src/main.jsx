import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter as Router } from 'react-router-dom';
import App from "./App";
import { AppProvider } from "./context/AppContext";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Router>
      <AppProvider>
        <App />
      </AppProvider>
    </Router>
  </React.StrictMode>
);
