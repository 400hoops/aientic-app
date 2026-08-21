import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import "./viewportHeight.js";
import "./vvDebug.js"; // TEMPORARY diagnostic, remove with the file

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
