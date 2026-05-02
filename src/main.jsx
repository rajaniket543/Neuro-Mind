import React from "react";
import ReactDOM from "react-dom/client";
import App from "../App (1).jsx";

document.body.style.margin = "0";
document.body.style.fontFamily = "system-ui, sans-serif";
document.body.style.background = "#080814";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
