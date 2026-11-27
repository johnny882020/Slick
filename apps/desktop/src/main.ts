import "./styles.css";
import { startApp } from "./app";
import { createTransport } from "./transport";

const root = document.getElementById("app");
if (root) {
  createTransport()
    .then((t) => startApp(root, t))
    .catch((e: unknown) => {
      root.textContent = `OneSeat could not start: ${e instanceof Error ? e.message : String(e)}`;
    });
}
