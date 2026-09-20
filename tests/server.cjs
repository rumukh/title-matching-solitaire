"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "..", "index.html");
const port = Number(process.env.PORT || 4173);
http.createServer((request, response) => {
  if (!["/", "/index.html"].includes(request.url.split("?")[0])) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => console.log(`Mahjong: http://127.0.0.1:${port}`));
