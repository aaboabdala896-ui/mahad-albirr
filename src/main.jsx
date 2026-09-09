import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./modern.css";
import { initPushNotifications } from "./pushNotifications.js";

const stopPushInit = initPushNotifications();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopPushInit?.());
}
