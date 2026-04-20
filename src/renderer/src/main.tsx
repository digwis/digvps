import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./styles.css"

// Apply saved theme before first render to avoid flash
const savedTheme = localStorage.getItem("digwis:theme") ?? "dark"
document.documentElement.classList.toggle("dark", savedTheme === "dark")

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
