import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";
import { PromptProvider } from "./components/Prompt";

createRoot(document.getElementById("root")!).render(
  <PromptProvider>
    <App />
  </PromptProvider>,
);
