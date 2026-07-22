import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./i18n"
import { useLocaleStore } from "./store/locale-store"
import "./styles.css"

void useLocaleStore.getState()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
