import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Design system (design/README.md): tokens, then cv-* components, then the button ripple.
import "../../design/tokens.css";
import "../../design/components/bundle.css";
import "../../design/components/bundle.js";
import "./app.css";
import App from "./App";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer = g.Buffer ?? Buffer;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
