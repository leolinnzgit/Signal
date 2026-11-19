import React from "react";
import ReactDOM from "react-dom/client";
import AuthApp from "./AuthApp";
import ListeningBreak from "../app/ListeningBreak";
import "../app/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ListeningBreak />
    <AuthApp />
  </React.StrictMode>,
);
