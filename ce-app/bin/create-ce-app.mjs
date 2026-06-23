#!/usr/bin/env node
// `npm create ce-app [dir]` -> runs `ce-app new chat [dir]`.
//
// npm invokes the create-* binary with the user's trailing args. We forward any
// directory argument and default the template to "chat".

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(__dirname, "ce-app.mjs");

// Pass through args. If the user gave no template, default to "chat".
// `npm create ce-app my-dir` => argv: ["my-dir"]  -> new chat my-dir
// `npm create ce-app`        => argv: []          -> new chat
const passed = process.argv.slice(2);
const args = ["new", "chat", ...passed];

const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  console.error("create-ce-app:", e.message);
  process.exit(1);
});
