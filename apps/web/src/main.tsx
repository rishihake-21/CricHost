import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  return <main><p className="eyebrow">CRICHOST PLATFORM</p><h1>Tournament operations, in one place.</h1><p className="intro">The product workspace scaffold is ready for implementation.</p><p className="status">Foundation scaffold · Release 1 planning</p></main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
